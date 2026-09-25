import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { CONSENT_NOTICE_VERSION } from "@gakushu-sochi/domain";
import { createAccessTokenProvider, type AccessTokenProvider } from "./access-token.js";
import { deleteConsent, readConsent, writeConsent } from "./consent.js";
import {
  buildAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  OAuthTokenError,
  randomState,
  revokeRefreshToken,
  type OAuthConfig,
} from "./oauth.js";
import {
  cookieValue,
  createLogin,
  createSession,
  deleteSession,
  peekLogin,
  expiredLoginCookie,
  expiredSessionCookie,
  loginCookie,
  readSession,
  sessionCookie,
  takeLogin,
} from "./session.js";

type WebBindings = CloudflareBindings;
type Fetch = typeof globalThis.fetch;

export interface WebAppDeps {
  fetch: Fetch;
  /** テストが時間を進められるようにする。既定は実時計。 */
  now?: () => number;
}

/** `/callback` の登録先。Auth0 の Allowed Callback URLs と一致していること。 */
const CALLBACK_PATH = "/callback";

function configured(value: string | undefined, name: string): string {
  if (!value) throw new HTTPException(500, { message: `${name} is not configured` });
  return value;
}

/**
 * 設定から来た送信先 origin を HTTPS かループバックに限る（.agents/rules/rules.md RULE-003）。
 *
 * 平文 HTTP の外部宛てにトークンを送る前に拒否する。
 */
function safeOrigin(value: string | undefined, name: string): URL {
  const raw = configured(value, name);
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    throw new HTTPException(500, { message: `${name} must be a valid URL` });
  }
  const localHttp =
    origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.protocol !== "https:" && !localHttp) {
    throw new HTTPException(500, { message: `${name} must use HTTPS` });
  }
  return origin;
}

function apiOrigin(value: string | undefined): URL {
  return safeOrigin(value, "API_ORIGIN");
}

function oauthConfig(env: WebBindings): OAuthConfig {
  // issuer もトークンと client secret を送る相手なので、同じ規則で検証する。
  const issuer = safeOrigin(env.AUTH_ISSUER, "AUTH_ISSUER");
  return {
    issuer: issuer.toString(),
    clientId: configured(env.AUTH_CLIENT_ID, "AUTH_CLIENT_ID"),
    clientSecret: configured(env.AUTH_CLIENT_SECRET, "AUTH_CLIENT_SECRET"),
    audience: configured(env.AUTH_AUDIENCE, "AUTH_AUDIENCE"),
  };
}

/**
 * セッションが無いことを、利用者が再ログインへ倒せる理由付きで返す。
 *
 * **Cookie を消すのは、そのセッションが無効だと確定したときだけにする。**
 * KV は結果整合なので、ログイン直後の最初の要求は「まだ伝播していないだけ」で
 * 空振りしうる（docs/web-viewer.md）。ここで一律に Cookie を消すと、
 * 画面が 1 回だけ行う再試行が資格情報を失い、必ずもう一度 401 になる。
 * 伝播待ちの回復経路が塞がるので、既定では消さない。
 */
function sessionExpired(c: Context<{ Bindings: WebBindings }>, options?: { clearCookie: boolean }) {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (options?.clearCookie) headers["set-cookie"] = expiredSessionCookie;
  return c.json({ error: "session_expired" }, 401, headers);
}

/**
 * セッション Cookie 自体が無いときの応答。
 *
 * `session_expired` と分けるのは、見せる画面が違うためである（Issue #182）。
 * Cookie を持たない訪問者は「期限が切れた」のではなく「まだログインしていない」ので、
 * エラー文面ではなくログインの導線を見せる。
 */
function loginRequired(c: Context<{ Bindings: WebBindings }>) {
  return c.json({ error: "login_required" }, 401, { "cache-control": "no-store" });
}

/**
 * 認証前エンドポイントへの到達を数える（docs/auth.md §5.3）。
 *
 * パスワード試行の制限は IdP の責務へ移ったが、`/login` と `/callback` は
 * 叩かれれば Auth0 への外向き通信が発生する。認証済みユーザーが居ない経路なので、
 * 鍵は引き続き `CF-Connecting-IP` を使う。
 */
async function preAuthRateLimit(c: {
  env: WebBindings;
  req: { header(name: string): string | undefined };
}) {
  const limiter = c.env.LOGIN_RATE_LIMITER;
  if (!limiter) throw new HTTPException(500, { message: "LOGIN_RATE_LIMITER is not configured" });
  const key = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (!(await limiter.limit({ key })).success)
    throw new HTTPException(429, { message: "too many login attempts" });
}

/**
 * 認可の失敗を、利用者が読める画面へ倒す。
 *
 * ここへ来るのはブラウザのトップレベル遷移なので、JSON を返すと生の本文が画面に出る。
 * SPA の `/login-failed` へ送り、やり直す導線を見せる。
 * **`reason` は分類名だけで、認可コードや `state` は載せない。**
 */
function loginFailed(c: Context<{ Bindings: WebBindings }>, reason: string) {
  console.warn("web login failed", { reason, ip: c.req.header("CF-Connecting-IP") ?? "unknown" });
  return new Response(null, {
    status: 302,
    headers: {
      location: `/login-failed?reason=${encodeURIComponent(reason)}`,
      "cache-control": "no-store",
      "set-cookie": expiredLoginCookie,
    },
  });
}

/**
 * 自分が始めたログインへの応答ではない `/callback`。
 *
 * **進行中のログインを壊さないことが目的**なので、Cookie も KV も触らない。
 * 利用者にはやり直しの導線だけを見せる。
 */
function unsolicitedCallback(c: Context<{ Bindings: WebBindings }>) {
  console.warn("unsolicited callback ignored", {
    ip: c.req.header("CF-Connecting-IP") ?? "unknown",
  });
  return new Response(null, {
    status: 302,
    headers: { location: "/login-failed?reason=unsolicited", "cache-control": "no-store" },
  });
}

export function createWebApp(
  deps: WebAppDeps = { fetch: (input, init) => globalThis.fetch(input, init) },
  accessTokens: AccessTokenProvider = createAccessTokenProvider({
    fetch: deps.fetch,
    ...(deps.now ? { now: deps.now } : {}),
  }),
) {
  const app = new Hono<{ Bindings: WebBindings }>();
  // テストが時刻を固定できるよう、実時計は注入に置き換えられる（docs/testing-guide.md §6）。
  const now = deps.now ?? (() => Date.now());

  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    console.error("unhandled web worker error", {
      message: error.message,
      stack: error.stack,
      path: c.req.path,
    });
    return c.json({ error: "internal server error" }, 500);
  });

  /**
   * IdP へのリダイレクト開始点。
   *
   * `state` を作って短命の pre-session Cookie に紐付ける。`/callback` で
   * **Refresh Token を保存する前に**一致を確かめる（docs/auth.md §5.3）。
   * PKCE は認可コードの横取りを防ぐが、ログイン CSRF は防がない。
   */
  app.get("/login", async (c) => {
    await preAuthRateLimit(c);
    const config = oauthConfig(c.env);
    const state = randomState();
    const pkce = await createPkcePair();
    const loginToken = await createLogin(c.env.SESSIONS, {
      state,
      codeVerifier: pkce.verifier,
    });
    const redirectUri = new URL(CALLBACK_PATH, c.req.url).toString();
    return new Response(null, {
      status: 302,
      headers: {
        location: buildAuthorizationUrl(config, redirectUri, state, pkce.challenge),
        "set-cookie": loginCookie(loginToken),
        "cache-control": "no-store",
      },
    });
  });

  /**
   * IdP からの戻り先。
   *
   * **`wrangler.jsonc` の `run_worker_first` にこのパスが要る。** 無いと assets バインディングが
   * `index.html` を返し、認可コードの交換が Worker に届かないまま静かに失敗する
   * （docs/web-viewer.md:99 の罠）。
   */
  app.get(CALLBACK_PATH, async (c) => {
    await preAuthRateLimit(c);
    const config = oauthConfig(c.env);
    const url = new URL(c.req.url);

    const loginToken = cookieValue(c.req.header("cookie"), "login");
    const state = url.searchParams.get("state");

    // IdP が返した `error` は利用者が制御しうる文字列なので、そのまま次の URL へ
    // 載せない。既知の値だけを通し、それ以外は 1 つの分類に丸める。
    //
    // **この枝でも `state` を確かめる。** 確かめずに進むと、攻撃者が
    // `/callback?error=access_denied` への遷移を誘導するだけで、進行中のログインを
    // 中断させられる。ただし `takeLogin` は読むと同時に消すので、ここでは使えない
    // （使うと、まさにその中断を自分で起こす）。**消さずに読んで**照合する。
    const authorizeError = url.searchParams.get("error");
    if (authorizeError) {
      const pending = await peekLogin(c.env.SESSIONS, loginToken);
      // 自分が始めたログインへの応答でなければ、何も壊さずに黙って追い返す。
      // 進行中のログインの Cookie も KV も、そのまま残す。
      if (!pending || !state || state !== pending.state) return unsolicitedCallback(c);
      await takeLogin(c.env.SESSIONS, loginToken);
      const known = ["access_denied", "login_required", "consent_required"];
      return loginFailed(c, known.includes(authorizeError) ? authorizeError : "authorize_failed");
    }

    // state の検証は **Refresh Token を保存する前**に済ませる。
    const login = await takeLogin(c.env.SESSIONS, loginToken);
    if (!login) return loginFailed(c, "login_state_missing");
    if (!state || state !== login.state) return loginFailed(c, "state_mismatch");

    const code = url.searchParams.get("code");
    if (!code) return loginFailed(c, "code_missing");

    const redirectUri = new URL(CALLBACK_PATH, c.req.url).toString();
    let tokens;
    try {
      tokens = await exchangeAuthorizationCode(
        config,
        code,
        redirectUri,
        login.codeVerifier,
        deps.fetch,
      );
    } catch (error) {
      // 交換の失敗を握りつぶさない（RULE-004）。利用者はやり直せる。
      console.error("authorization code exchange failed", {
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof OAuthTokenError
          ? {
              code: error.code,
              status: error.status,
              cause:
                error.cause instanceof Error
                  ? { name: error.cause.name, message: error.cause.message }
                  : String(error.cause ?? "unknown"),
            }
          : {}),
      });
      return loginFailed(c, "token_exchange_failed");
    }

    const token = await createSession(c.env.SESSIONS, {
      refreshToken: tokens.refreshToken,
      sub: tokens.sub,
    });
    console.log("web login succeeded", { sub: tokens.sub });
    const headers = new Headers({
      // KV は結果整合で、張ったばかりのセッションが別のエッジへ伝わるまで
      // 遅れうる（docs/web-viewer.md「セッションの整合性について認めておくこと」）。
      // 画面が最初の 401 を 1 回だけ再試行できるよう、ログイン直後であることを伝える。
      location: "/?login=1",
      "cache-control": "no-store",
    });
    headers.append("set-cookie", sessionCookie(token));
    // 使い終わった pre-session Cookie を残さない。KV の値は既に消費済み。
    headers.append("set-cookie", expiredLoginCookie);
    return new Response(null, { status: 302, headers });
  });

  /**
   * ログアウト。**先に KV のセッションを消し**、その後 IdP の RT を撤回する
   * （docs/auth.md §8）。利用者を守っているのは KV の削除であり、撤回の成否ではない。
   */
  app.post("/logout", async (c) => {
    const token = cookieValue(c.req.header("cookie"), "session");
    const session = await readSession(c.env.SESSIONS, token);
    if (token) {
      // **`forget` を KV の削除より先に呼ぶ。** これが進行中の refresh へ
      // 「結果を書き戻すな」という印を立てる。順序を逆にすると、削除を待つ間に
      // refresh が完了し、消したはずのセッションが KV へ蘇りうる。
      accessTokens.forget(token);
      await deleteSession(c.env.SESSIONS, token);
    }
    if (session) {
      try {
        await revokeRefreshToken(oauthConfig(c.env), session.refreshToken, deps.fetch);
      } catch (error) {
        // 撤回の失敗は握りつぶさずログへ残す。露出は AT の寿命（15分）に上限される。
        console.error("refresh token revocation failed", {
          sub: session.sub,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return new Response(null, {
      status: 204,
      headers: { "set-cookie": expiredSessionCookie, "cache-control": "no-store" },
    });
  });

  /**
   * ログイン状態の確認（Issue #182）。
   *
   * ヘッダーの「ログイン / ログアウト」の切り替えに使う。未ログインでも
   * 200 を返す —— 状態を知る手段が認証で止まると、未ログインであること自体を
   * 画面へ伝えられなくなる。`run_worker_first` にこのパスが要る。
   */
  app.get("/session", async (c) => {
    const session = await readSession(
      c.env.SESSIONS,
      cookieValue(c.req.header("cookie"), "session"),
    );
    return c.json({ loggedIn: session !== undefined }, 200, { "cache-control": "no-store" });
  });

  /**
   * 同意の記録の読み出し（#174）。
   *
   * 記録は `consent:{sub}` として KV に置く（worker/consent.ts）。この経路は
   * `/api/*` の中継ではなく Worker 自身の endpoint で、**同意が無くても
   * 呼べる必要がある**（同意状態を知る手段が同意で止まると先へ進めない）。
   */
  app.get("/consent", async (c) => {
    const token = cookieValue(c.req.header("cookie"), "session");
    const session = await readSession(c.env.SESSIONS, token);
    if (!token) return loginRequired(c);
    if (!session) return sessionExpired(c);
    const record = await readConsent(c.env.SESSIONS, session.sub);
    return c.json(
      { granted: record !== undefined, ...(record ? { grantedAt: record.grantedAt } : {}) },
      200,
      { "cache-control": "no-store" },
    );
  });

  /**
   * 同意の記録。**利用者が実際に見た文面の版を本文で受け取り**、Worker の版と
   * 一致するときだけ記録する。古い同梱の文面へ同意した人へ新しい版の同意を
   * 記録しないためである（同意は「その文面」への合意）。
   */
  app.put("/consent", async (c) => {
    const token = cookieValue(c.req.header("cookie"), "session");
    const session = await readSession(c.env.SESSIONS, token);
    if (!token) return loginRequired(c);
    if (!session) return sessionExpired(c);
    const body = (await c.req.json().catch(() => ({}))) as { version?: unknown };
    if (body.version !== CONSENT_NOTICE_VERSION) {
      return c.json({ error: "consent_notice_outdated" }, 409, {
        "cache-control": "no-store",
      });
    }
    const record = await writeConsent(c.env.SESSIONS, session.sub, new Date(now()).toISOString());
    return c.json({ granted: true, grantedAt: record.grantedAt }, 200, {
      "cache-control": "no-store",
    });
  });

  /**
   * 同意の取り消し。以降の書き込みは止まる。**既に送ったデータは消えない**
   * （削除は `DELETE /v1/learning-events` が持つ）。
   */
  app.delete("/consent", async (c) => {
    const token = cookieValue(c.req.header("cookie"), "session");
    const session = await readSession(c.env.SESSIONS, token);
    if (!token) return loginRequired(c);
    if (!session) return sessionExpired(c);
    await deleteConsent(c.env.SESSIONS, session.sub);
    return c.json({ granted: false }, 200, { "cache-control": "no-store" });
  });

  /**
   * API への中継。**共有トークンではなく、セッションに紐づくユーザーの AT を注入する。**
   */
  app.all("/api/*", async (c) => {
    const sessionToken = cookieValue(c.req.header("cookie"), "session");
    const session = await readSession(c.env.SESSIONS, sessionToken);
    if (!sessionToken) return loginRequired(c);
    if (!session) return sessionExpired(c);

    // #174: 書き込み系の要求は、同意の記録があるときだけ上流へ中継する。
    // 版が古い・壊れた記録は同意なしとして扱う（readConsent の仕様）。
    // GET/HEAD の閲覧と DELETE は利用者の本文を送らないので対象外。
    // 特に削除は「同意を取り消したあとにも使える別操作」なので、同意で
    // 止めると取り消した人が自分のデータを消せなくなる。ログインや
    // `/consent` 自体など同意の前に必要な経路を止めないためでもある。
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.method !== "DELETE") {
      const consent = await readConsent(c.env.SESSIONS, session.sub);
      if (!consent) {
        return c.json({ error: "consent_required" }, 403, { "cache-control": "no-store" });
      }
    }

    const origin = apiOrigin(c.env.API_ORIGIN);
    const token = await accessTokens.get(c.env.SESSIONS, sessionToken, session, oauthConfig(c.env));
    if (!token.ok) {
      // RT が失効・撤回済みで確定した（KV は削除済み）。Cookie も消してよい。
      if (token.kind === "session_expired") return sessionExpired(c, { clearCookie: true });
      // 一時的な失敗。**セッションは残っている**ので、そのまま再試行できる。
      return c.json({ error: "auth_unavailable" }, 503, {
        "cache-control": "no-store",
        "retry-after": "5",
      });
    }

    const requestUrl = new URL(c.req.url);
    const target = new URL(requestUrl.pathname.replace(/^\/api/, "") + requestUrl.search, origin);
    const headers = new Headers(c.req.raw.headers);
    headers.set("authorization", `Bearer ${token.accessToken}`);
    headers.delete("cookie");
    headers.set("host", origin.host);
    const upstream = await deps.fetch(target, {
      method: c.req.method,
      headers,
      body: c.req.raw.body,
      // Workers は redirect: "error" を実装していないため manual にする。
      // API の3xxは下流へ返さず、資格情報付きの自動追跡を防ぐ（RULE-002）。
      redirect: "manual",
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      return c.json({ error: "upstream_redirect" }, 502, { "cache-control": "no-store" });
    }
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("cache-control", "no-store");
    if (upstream.status === 401) {
      // API が個人のトークンを拒否した。共有トークンが無くなったので、
      // この 401 は「このセッションではもう通らない」という意味しか持たない。
      //
      // **ブラウザの Cookie を消すだけでは足りない。** KV のセッションを残すと、
      // 同じ Cookie を持つ別の誰か（コピーされた Cookie）が refresh を回して
      // 使い続けられる。利用者には「期限切れ」と伝えておきながら、
      // サーバー側の資格情報が最大 7 日生き続ける状態になる。
      // サーバー側を正本として先に消す。
      accessTokens.forget(sessionToken);
      await deleteSession(c.env.SESSIONS, sessionToken);
      return sessionExpired(c, { clearCookie: true });
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  });

  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}

const app = createWebApp();
export default { fetch: app.fetch } satisfies ExportedHandler<WebBindings>;
