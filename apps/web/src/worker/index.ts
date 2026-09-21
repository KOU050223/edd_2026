import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { createAccessTokenProvider, type AccessTokenProvider } from "./access-token.js";
import {
  buildAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  randomState,
  revokeRefreshToken,
  type OAuthConfig,
} from "./oauth.js";
import {
  cookieValue,
  createLogin,
  createSession,
  deleteSession,
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

/** セッションが無いことを、利用者が再ログインへ倒せる理由付きで返す。 */
function sessionExpired(c: Context<{ Bindings: WebBindings }>) {
  return c.json({ error: "session_expired" }, 401, {
    "cache-control": "no-store",
    "set-cookie": expiredSessionCookie,
  });
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

export function createWebApp(
  deps: WebAppDeps = { fetch: (input, init) => globalThis.fetch(input, init) },
  accessTokens: AccessTokenProvider = createAccessTokenProvider({
    fetch: deps.fetch,
    ...(deps.now ? { now: deps.now } : {}),
  }),
) {
  const app = new Hono<{ Bindings: WebBindings }>();

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

    // IdP が返した `error` は利用者が制御しうる文字列なので、そのまま次の URL へ
    // 載せない。既知の値だけを通し、それ以外は 1 つの分類に丸める。
    const authorizeError = url.searchParams.get("error");
    if (authorizeError) {
      const known = ["access_denied", "login_required", "consent_required"];
      return loginFailed(c, known.includes(authorizeError) ? authorizeError : "authorize_failed");
    }

    // state の検証は **Refresh Token を保存する前**に済ませる。
    const login = await takeLogin(c.env.SESSIONS, cookieValue(c.req.header("cookie"), "login"));
    if (!login) return loginFailed(c, "login_state_missing");
    const state = url.searchParams.get("state");
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
      await deleteSession(c.env.SESSIONS, token);
      accessTokens.forget(token);
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
   * API への中継。**共有トークンではなく、セッションに紐づくユーザーの AT を注入する。**
   */
  app.all("/api/*", async (c) => {
    const sessionToken = cookieValue(c.req.header("cookie"), "session");
    const session = await readSession(c.env.SESSIONS, sessionToken);
    if (!sessionToken || !session) return sessionExpired(c);

    const origin = apiOrigin(c.env.API_ORIGIN);
    const token = await accessTokens.get(c.env.SESSIONS, sessionToken, session, oauthConfig(c.env));
    if (!token.ok) {
      if (token.kind === "session_expired") return sessionExpired(c);
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
      // 資格情報を載せるのでリダイレクトを追跡しない（RULE-002）。
      redirect: "error",
    });
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("cache-control", "no-store");
    if (upstream.status === 401) {
      // API が個人のトークンを拒否した。共有トークンが無くなったので、
      // この 401 は「このセッションではもう通らない」という意味しか持たない。
      accessTokens.forget(sessionToken);
      return sessionExpired(c);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  });

  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}

const app = createWebApp();
export default { fetch: app.fetch } satisfies ExportedHandler<WebBindings>;
