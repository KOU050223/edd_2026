/**
 * Auth0 が発行したアクセストークン（JWT）の検証器。
 *
 * `middleware.ts` は「リクエストから userId を決める」という責務だけを持ち、
 * トークンの中身の検証はここが引き受ける。分ける理由は2つある。
 *
 * 1. docs/auth.md §4 が要求する継ぎ目の2つ目がここにある。Discovery と JWKS の
 *    取得に使う `fetch` を注入可能にすることで、スタブの JWKS と自前で生成した鍵で
 *    「本物の署名を持つ JWT」を検証できる。偽の検証器を挿すだけでは、署名・`nbf`・
 *    Discovery の検証そのものをテストできない。
 * 2. 署名検証に使う WebCrypto は Node にもあるため、`test:unit` は素の vitest の
 *    まま（Worker ランタイム無し）で通る。
 */

/** 検証を通ったトークンから取り出した主体。`sub` を userId として使う。 */
export interface VerifiedToken {
  sub: string;
}

/** `middleware.ts` が依存する検証器の形。テストではこれを差し替える。 */
export interface AuthVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

/**
 * 検証に失敗した理由の区別。
 *
 * トークンが不正（401）なのか、こちら側の設定・通信の問題（500）なのかを
 * 呼び出し側が判別できるようにする。両者を同じ例外へ潰すと、Auth0 へ到達できない
 * 障害が「トークンが不正」として現れ、原因の切り分けができなくなる
 * （.agents/rules/rules.md RULE-004）。
 */
export type AuthFailureKind = "invalid_token" | "configuration" | "unavailable";

export class AuthVerificationError extends Error {
  constructor(
    readonly kind: AuthFailureKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AuthVerificationError";
  }
}

/**
 * 許可する issuer のホスト。**設定項目にしない。**
 *
 * docs/auth.md §4 は JWKS の URL を設定可能にしないことを求めている。理由は
 * 「JWKS の取得先だけ攻撃者のサーバーへ向ける」誤設定が成立し、任意の鍵で署名した
 * トークンが通るためである。その導出元である `AUTH_ISSUER` を任意の URL のまま
 * 受け取ると、消したはずの穴が一段上に戻ってくる。したがってホストの許可リストは
 * 環境変数ではなくコードに置く。テナントを増やすときはコードの変更とレビューを要する。
 */
const ALLOWED_ISSUER_HOSTS: readonly string[] = [
  "gakushu-sochi.jp.auth0.com",
  "auth.gakushu-sochi.dev",
];

/**
 * 受け付ける署名アルゴリズム。
 *
 * RS256 だけを許す。`alg` はトークンのヘッダではなく JWKS の鍵から決める。
 * ヘッダの `alg` を信じると、攻撃者が `none` を指定して署名検証を飛ばしたり、
 * 公開鍵を HMAC の鍵として使わせる古典的な攻撃が成立する。
 */
const ALLOWED_ALG = "RS256";

/**
 * `exp` / `nbf` の判定に許す時刻のずれ。
 *
 * サーバー間の時計は完全には一致しない。ずらしすぎると失効したトークンを
 * 受け付ける時間が延びるため、60秒に留める。
 */
const CLOCK_SKEW_SECONDS = 60;

/** Discovery / JWKS の取得にかける上限（.agents/rules/rules.md RULE-001）。 */
const FETCH_TIMEOUT_MS = 5_000;

/** JWKS を Cache API へ保存するときの寿命。鍵の更新に追従できる長さにする。 */
const JWKS_CACHE_TTL_SECONDS = 600;

/**
 * 解決しなかった `kid` を再取得しないでおく時間。
 *
 * 未知の `kid` を持つトークンを投げ続けるだけで Auth0 への外向き通信を
 * 1リクエストずつ増やせる。一度引いて見つからなかった `kid` は、この時間だけ
 * 取得せずに 401 を返す（docs/auth.md §4）。
 */
const UNKNOWN_KID_COOLDOWN_MS = 60_000;

/**
 * `kid` によらず、JWKS を引き直す間隔の下限。
 *
 * `kid` ごとのクールダウンだけでは足りない。**毎回違う** `kid` を名乗る
 * トークンを投げれば、クールダウンは常に外れ、1リクエストにつき1回の
 * 外向き通信が発生する。署名の検証は鍵を引いた後なので、正しい署名すら要らない。
 * レート制限は認証の後段にあり（userId で数えるため）ここには効かない。
 * したがって取得そのものに下限を置き、この窓の中で解決しない `kid` は
 * 取得せずに 401 とする（docs/auth.md §4）。
 */
const JWKS_REFRESH_FLOOR_MS = 60_000;

/**
 * `unknownKids` に残す件数の上限。
 *
 * 攻撃者が与える `kid` は無数にありうる。上限を置かないと、isolate の寿命の間
 * 際限なく増える。古いものから捨てる（Map は挿入順を保つ）。
 */
const UNKNOWN_KID_MAX_ENTRIES = 1_000;

/**
 * JWKS のキャッシュに使う最小の窓口。
 *
 * Workers の Cache API（`caches.default`）をそのまま要求すると、`caches` を持たない
 * Node で `test:unit` が動かない。必要な操作だけを型にして注入可能にする。
 */
export interface JwksCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

/** どこにも保存しないキャッシュ。テストと、Cache API が無い環境の既定。 */
export const noopJwksCache: JwksCache = {
  match: () => Promise.resolve(undefined),
  put: () => Promise.resolve(),
};

export interface Auth0VerifierOptions {
  /** `AUTH_ISSUER`。OIDC Discovery が返す値と一致していなければならない。 */
  issuer: string;
  /** `AUTH_AUDIENCE`。自 API の識別子。 */
  audience: string;
  /** Discovery と JWKS の取得に使う。テストではスタブを挿す（docs/auth.md §4）。 */
  fetch: typeof fetch;
  /** JWKS のキャッシュ。既定は保存しない。 */
  cache?: JwksCache;
}

interface JsonWebKey_ {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

/** Auth0 のアクセストークンを検証する `AuthVerifier` の実装。 */
export class Auth0Verifier implements AuthVerifier {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: JwksCache;

  /** Discovery は isolate ごとに一度だけ解決する。結果の Promise を保持する。 */
  private discovery?: Promise<{ jwksUri: string }>;

  /** 取り込み済みの公開鍵。`kid` から引く。 */
  private readonly keys = new Map<string, CryptoKey>();

  /** 進行中の JWKS 取得。single-flight にして再取得の増幅を防ぐ（docs/auth.md §4）。 */
  private inflightJwks?: Promise<void>;

  /** 解決しなかった `kid` と、その時刻。クールダウンの判定に使う。 */
  private readonly unknownKids = new Map<string, number>();

  /** 直近で JWKS の取得を試みた時刻。取得の間隔に下限を置くために使う。 */
  private lastJwksAttemptAt?: number;

  constructor(options: Auth0VerifierOptions) {
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.fetchImpl = options.fetch;
    this.cache = options.cache ?? noopJwksCache;
  }

  async verify(token: string): Promise<VerifiedToken> {
    const { header, payload, signingInput, signature } = decodeJwt(token);

    // ヘッダの `alg` は信用の根拠にしないが、RS256 以外を名乗るトークンは
    // ここで落とす。鍵を引く前に弾けるものは弾く。
    if (header.alg !== ALLOWED_ALG) {
      throw new AuthVerificationError("invalid_token", "unsupported token algorithm");
    }
    if (typeof header.kid !== "string" || header.kid.length === 0) {
      throw new AuthVerificationError("invalid_token", "token has no key id");
    }

    const key = await this.resolveKey(header.kid);

    const verified = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      signature,
      new TextEncoder().encode(signingInput),
    );
    if (!verified) {
      throw new AuthVerificationError("invalid_token", "token signature is invalid");
    }

    // 署名を確かめてからクレームを見る。順序を逆にすると、署名されていない
    // 値に基づいて判断することになる。
    this.assertClaims(payload);

    const sub = payload.sub;
    if (typeof sub !== "string" || sub.length === 0) {
      // userId の実体が無いまま通すと、全員が同じ空文字として数えられる。
      throw new AuthVerificationError("invalid_token", "token has no subject");
    }
    return { sub };
  }

  /** `iss` / `aud` / `exp` / `nbf` を確かめる（docs/auth.md §4）。 */
  private assertClaims(payload: Record<string, unknown>): void {
    if (payload.iss !== this.issuer) {
      throw new AuthVerificationError("invalid_token", "token issuer mismatch");
    }

    // `aud` は文字列にも配列にもなる。Auth0 は audience が複数あるとき配列を返す。
    // これを検証しないと、同じテナントの別アプリ向けトークンで自 API を呼べる。
    const aud = payload.aud;
    const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
    if (!audiences.includes(this.audience)) {
      throw new AuthVerificationError("invalid_token", "token audience mismatch");
    }

    const now = Math.floor(Date.now() / 1000);

    const exp = payload.exp;
    if (typeof exp !== "number") {
      // 期限の無いトークンは失効しない。無期限の資格情報として扱わない。
      throw new AuthVerificationError("invalid_token", "token has no expiration");
    }
    if (now >= exp + CLOCK_SKEW_SECONDS) {
      throw new AuthVerificationError("invalid_token", "token is expired");
    }

    const nbf = payload.nbf;
    if (typeof nbf === "number" && now < nbf - CLOCK_SKEW_SECONDS) {
      throw new AuthVerificationError("invalid_token", "token is not yet valid");
    }
  }

  /**
   * `kid` に対応する公開鍵を返す。
   *
   * 取り込み済みなら取得しない。未知なら JWKS を引き直すが、single-flight にし、
   * 解決しなかった `kid` にはクールダウンを置く。そうしないと、未知の `kid` を
   * 持つトークンを投げ続けるだけで外向き通信を増やせる（docs/auth.md §4）。
   */
  private async resolveKey(kid: string): Promise<CryptoKey> {
    const cached = this.keys.get(kid);
    if (cached !== undefined) {
      return cached;
    }

    const failedAt = this.unknownKids.get(kid);
    if (failedAt !== undefined && Date.now() - failedAt < UNKNOWN_KID_COOLDOWN_MS) {
      throw new AuthVerificationError("invalid_token", "token key id is unknown");
    }

    // 取得そのものに間隔の下限を置く。`kid` ごとのクールダウンは、毎回違う
    // `kid` を名乗られると外れ続けるため、これが無いと外向き通信を
    // 1リクエストずつ増やせる。
    if (!this.mayAttemptRefresh()) {
      this.rememberUnknownKid(kid);
      throw new AuthVerificationError("invalid_token", "token key id is unknown");
    }

    // 相乗りした取得は、この `kid` が公開される前に始まっていたかもしれない。
    // その結果でクールダウンを置くと、鍵の更新中に発行された正当なトークンを
    // 拒み続けることになる。自分のために始まった取得でなければ、
    // もう一度だけ引き直してから判定する。
    const joined = await this.refreshKeys();

    let refreshed = this.keys.get(kid);
    if (refreshed === undefined && joined) {
      await this.refreshKeys();
      refreshed = this.keys.get(kid);
    }

    if (refreshed === undefined) {
      this.rememberUnknownKid(kid);
      throw new AuthVerificationError("invalid_token", "token key id is unknown");
    }
    // 一度解決できた `kid` はクールダウンの記録から外す。
    this.unknownKids.delete(kid);
    return refreshed;
  }

  /**
   * JWKS を引き直してよいかを返す。
   *
   * 進行中の取得があれば相乗りできるので待たせる。そうでなければ、前回の試行から
   * `JWKS_REFRESH_FLOOR_MS` 以上空いているときだけ許す。
   */
  private mayAttemptRefresh(): boolean {
    if (this.inflightJwks !== undefined) {
      return true;
    }
    const last = this.lastJwksAttemptAt;
    return last === undefined || Date.now() - last >= JWKS_REFRESH_FLOOR_MS;
  }

  /** 解決しなかった `kid` を、件数に上限を置いて記録する。 */
  private rememberUnknownKid(kid: string): void {
    // 上限を超えたら最も古い記録から捨てる。Map は挿入順を保つ。
    if (this.unknownKids.size >= UNKNOWN_KID_MAX_ENTRIES) {
      const oldest = this.unknownKids.keys().next();
      if (!oldest.done) {
        this.unknownKids.delete(oldest.value);
      }
    }
    this.unknownKids.set(kid, Date.now());
  }

  /**
   * JWKS を取り込む。同時に呼ばれても取得は1回に畳む。
   *
   * 進行中の取得に相乗りしたかどうかを返す。相乗りした呼び出しは、自分が必要と
   * する `kid` が公開される前に始まった取得を見ている可能性があるため、
   * 呼び出し側がその区別を要る（`resolveKey`）。
   */
  private refreshKeys(): Promise<boolean> {
    const inflight = this.inflightJwks;
    if (inflight !== undefined) {
      return inflight.then(() => true);
    }

    // 実際に取得を始める時刻を記録する。失敗しても記録するのは、
    // 落ちている上流へ毎リクエスト取りに行かないためである。
    this.lastJwksAttemptAt = Date.now();

    // 失敗も相乗り先へ共有するが、`inflightJwks` は完了時に必ず捨てるため、
    // 次の呼び出しは新しい取得になる。
    const started = this.fetchKeys().finally(() => {
      this.inflightJwks = undefined;
    });
    this.inflightJwks = started;
    return started.then(() => false);
  }

  private async fetchKeys(): Promise<void> {
    const { jwksUri } = await this.resolveDiscovery();

    const cachedJwks = await this.readCachedJwks(jwksUri);
    const jwks = cachedJwks ?? (await this.fetchAndCacheJwks(jwksUri));

    const keys = Array.isArray(jwks.keys) ? (jwks.keys as JsonWebKey_[]) : [];
    for (const jwk of keys) {
      // 署名用の RSA 鍵だけを取り込む。`alg` は鍵の側の宣言を使う。
      if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
      if (jwk.alg !== undefined && jwk.alg !== ALLOWED_ALG) continue;
      if (jwk.use !== undefined && jwk.use !== "sig") continue;
      if (typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;

      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: ALLOWED_ALG, ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      this.keys.set(jwk.kid, key);
    }
  }

  private async readCachedJwks(jwksUri: string): Promise<Record<string, unknown> | undefined> {
    const hit = await this.cache.match(jwksUri);
    if (hit === undefined) {
      return undefined;
    }
    try {
      return (await hit.json()) as Record<string, unknown>;
    } catch (cause) {
      // キャッシュが壊れていても黙って成功にはしない。取得し直せるので、
      // 記録したうえで先へ進む（.agents/rules/rules.md RULE-004）。
      console.error("cached JWKS is not valid JSON", { jwksUri, cause });
      return undefined;
    }
  }

  private async fetchAndCacheJwks(jwksUri: string): Promise<Record<string, unknown>> {
    const response = await this.fetchJson(jwksUri, "JWKS");
    const body = await readJson(response.clone(), "JWKS");

    // 取得できたものだけをキャッシュへ入れる。寿命を明示しないと、
    // 上流のヘッダ次第で鍵の更新へ追従できなくなる。
    const cacheable = new Response(JSON.stringify(body), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `max-age=${JWKS_CACHE_TTL_SECONDS}`,
      },
    });
    await this.cache.put(jwksUri, cacheable);

    return body;
  }

  /**
   * OIDC Discovery から `jwks_uri` を導出する。
   *
   * JWKS の URL を設定項目にしないための経路（docs/auth.md §4）。ただし導出元と
   * 導出先の両方を確かめないと、Discovery が乗っ取られたときに鍵の取得先だけを
   * 逃がされる。
   */
  private resolveDiscovery(): Promise<{ jwksUri: string }> {
    this.discovery ??= this.fetchDiscovery().catch((error: unknown) => {
      // 失敗を isolate の寿命だけ固定しない。次のリクエストで引き直せるようにする。
      this.discovery = undefined;
      throw error;
    });
    return this.discovery;
  }

  private async fetchDiscovery(): Promise<{ jwksUri: string }> {
    const issuerUrl = assertAllowedOrigin(this.issuer, "AUTH_ISSUER");

    // issuer は末尾スラッシュを持つ。`.well-known` を二重スラッシュ無しで繋ぐ。
    const discoveryUrl = new URL(
      ".well-known/openid-configuration",
      issuerUrl.href.endsWith("/") ? issuerUrl.href : `${issuerUrl.href}/`,
    );

    const response = await this.fetchJson(discoveryUrl.toString(), "discovery document");
    const document = await readJson(response, "discovery document");

    // Discovery 文書の `issuer` が設定値と一致することを確かめる。
    if (document.issuer !== this.issuer) {
      throw new AuthVerificationError(
        "configuration",
        "discovery document issuer does not match AUTH_ISSUER",
      );
    }

    const jwksUri = document.jwks_uri;
    if (typeof jwksUri !== "string" || jwksUri.length === 0) {
      throw new AuthVerificationError("unavailable", "discovery document has no jwks_uri");
    }

    // Discovery 自体が乗っ取られた場合に、鍵の取得先だけ逃がされるのを防ぐ。
    const jwksUrl = assertAllowedOrigin(jwksUri, "jwks_uri");
    if (jwksUrl.host !== issuerUrl.host) {
      throw new AuthVerificationError("configuration", "jwks_uri host differs from issuer host");
    }

    return { jwksUri: jwksUrl.toString() };
  }

  /** 外向きの単発 GET。タイムアウトとリダイレクト禁止を共通で掛ける。 */
  private async fetchJson(url: string, label: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        // 応答が返らないまま待ち続けると、Worker の課金時間を食い潰す
        // （.agents/rules/rules.md RULE-001）。
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        // リダイレクトを追跡しない。直前に確かめたホストの固定が、これで初めて
        // 実効になる（.agents/rules/rules.md RULE-002）。
        redirect: "error",
        headers: { Accept: "application/json" },
      });
    } catch (cause) {
      // 取得できないのはトークンの不正ではない。401 に丸めると「トークンが違う」
      // として現れ、Auth0 への到達不能が見えなくなる（RULE-004）。
      throw new AuthVerificationError("unavailable", `failed to fetch ${label}`, { cause });
    }

    if (!response.ok) {
      throw new AuthVerificationError(
        "unavailable",
        `failed to fetch ${label}: status ${response.status}`,
      );
    }
    return response;
  }
}

/** 応答本文を JSON として読む。2xx でも解析できなければ失敗として扱う（RULE-004）。 */
async function readJson(response: Response, label: string): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch (cause) {
    throw new AuthVerificationError("unavailable", `${label} is not valid JSON`, { cause });
  }
}

/**
 * URL が https で、許可したホストに属することを確かめる。
 *
 * 平文 HTTP を許すと、経路上で鍵をすり替えられる。ホストを固定するのは、
 * 設定や Discovery の乗っ取りで取得先だけを差し替えられないようにするため。
 */
function assertAllowedOrigin(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new AuthVerificationError("configuration", `${label} is not a valid URL`, { cause });
  }

  if (url.protocol !== "https:") {
    throw new AuthVerificationError("configuration", `${label} must use https`);
  }
  if (!ALLOWED_ISSUER_HOSTS.includes(url.host)) {
    throw new AuthVerificationError("configuration", `${label} host is not allowed`);
  }
  return url;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface DecodedJwt {
  header: JwtHeader;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array<ArrayBuffer>;
}

/** JWT を3つの部分に分けて復号する。ここでは形式だけを見る。 */
function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AuthVerificationError("invalid_token", "token is not a JWT");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  return {
    header: decodeJsonSegment(encodedHeader, "header"),
    payload: decodeJsonSegment(encodedPayload, "payload"),
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature: decodeBase64Url(encodedSignature),
  };
}

function decodeJsonSegment<T>(segment: string, label: string): T {
  const bytes = decodeBase64Url(segment);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (cause) {
    throw new AuthVerificationError("invalid_token", `token ${label} is not valid JSON`, { cause });
  }
}

function decodeBase64Url(segment: string): Uint8Array<ArrayBuffer> {
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch (cause) {
    throw new AuthVerificationError("invalid_token", "token is not valid base64url", { cause });
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
