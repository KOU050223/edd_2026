/**
 * Web 用の OAuth 2.0 クライアント（Authorization Code + PKCE）。
 *
 * **Web だけが confidential client である**（docs/auth.md §5）。Worker がサーバー側で
 * 認可コードを交換するので `client_secret` を持てる。`token_endpoint_auth_method` は
 * `client_secret_post` なので、secret は本文へ載せる。
 *
 * Node の `node:crypto` は使わない（Workers では `nodejs_compat` が要る）。
 * WebCrypto だけで完結させる。
 */
import { base64Url } from "./session.js";

/** 単発の外向きリクエスト。応答が返らないまま待ち続けない（.agents/rules/rules.md RULE-001）。 */
const TOKEN_TIMEOUT_MS = 10_000;

export interface OAuthConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  audience: string;
}

/**
 * トークンエンドポイントが返したエラー。
 *
 * **呼び出し側はメッセージ文字列ではなく `code` で分類すること。**
 * セッションを消してよいのは `invalid_grant`（RT が失効・撤回済み）のときだけで、
 * タイムアウト・5xx・レート制限はセッションを残して再試行させる（docs/auth.md §5.3）。
 */
export class OAuthTokenError extends Error {
  readonly code: string | undefined;
  readonly status: number;

  constructor(message: string, options: { code?: string; status: number; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OAuthTokenError";
    this.code = options.code;
    this.status = options.status;
  }

  /** RT が二度と使えないことが確定したか。ここが true のときだけセッションを消す。 */
  get isInvalidGrant(): boolean {
    return this.code === "invalid_grant";
  }
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  sub: string;
}

export interface RefreshedAccessToken {
  accessToken: string;
  expiresInSeconds: number;
  /** rotation で新しい RT が返った場合だけ入る。返らなければ古い RT を使い続ける。 */
  refreshToken?: string;
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export function randomState(): string {
  return randomBase64Url(32);
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomBase64Url(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function buildAuthorizationUrl(
  config: OAuthConfig,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL("/authorize", config.issuer);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    // `offline_access` が無いと Refresh Token が返らず、KV に保存する対象が
    // 存在しなくなる（docs/auth.md §5.3）。
    scope: "openid profile email offline_access",
    audience: config.audience,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export async function exchangeAuthorizationCode(
  config: OAuthConfig,
  code: string,
  redirectUri: string,
  codeVerifier: string,
  fetchImpl: typeof fetch,
): Promise<OAuthTokens> {
  const body = await requestToken(
    config,
    {
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    },
    fetchImpl,
  );
  const accessToken = readString(body.access_token, "access_token");
  return {
    accessToken,
    refreshToken: readString(body.refresh_token, "refresh_token"),
    expiresInSeconds: readExpiresIn(body.expires_in),
    sub: subjectOf(accessToken),
  };
}

export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<RefreshedAccessToken> {
  const body = await requestToken(
    config,
    {
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    },
    fetchImpl,
  );
  const rotated =
    typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? body.refresh_token
      : undefined;
  return {
    accessToken: readString(body.access_token, "access_token"),
    expiresInSeconds: readExpiresIn(body.expires_in),
    ...(rotated ? { refreshToken: rotated } : {}),
  };
}

/**
 * Refresh Token を IdP 側で撤回する（docs/auth.md §8）。
 *
 * **呼ぶ側は、これより先に KV のセッションを消していること。**
 * 利用者を守っているのは KV の削除であり、この撤回の成否ではない。
 * ここが失敗しても露出はアクセストークンの寿命（15分）に上限される。
 */
export async function revokeRefreshToken(
  config: OAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(`${trimSlash(config.issuer)}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // 資格情報を載せるのでリダイレクトを追跡しない（RULE-002）。
    redirect: "error",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      token: refreshToken,
    }),
  });
  // 失敗を握りつぶさず、呼び出し側がログへ残せるよう投げる（RULE-004）。
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new OAuthTokenError(
      `OAuth トークンの撤回に失敗しました (${response.status}): ${detail.slice(0, 200)}`,
      { status: response.status },
    );
  }
}

interface OAuthTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

async function requestToken(
  config: OAuthConfig,
  values: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<OAuthTokenResponse> {
  let response: Response;
  try {
    response = await fetchImpl(`${trimSlash(config.issuer)}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      body: new URLSearchParams(values),
    });
  } catch (error) {
    // ネットワーク障害とタイムアウト。**`invalid_grant` ではない**ので、
    // 呼び出し側がセッションを消さずに再試行できるよう `code` を付けずに投げる。
    throw new OAuthTokenError("OAuth トークンエンドポイントへ到達できません", {
      status: 0,
      cause: error,
    });
  }
  const rawBody = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch (error) {
    // 2xx でも本文を解析できなければ失敗として扱う（RULE-004）。
    throw new OAuthTokenError("OAuth トークン応答を解析できません", {
      status: response.status,
      cause: error,
    });
  }
  if (!response.ok) {
    throw new OAuthTokenError(
      `OAuth トークン取得に失敗しました (${response.status}): ${getErrorDescription(body)}`,
      { code: getErrorCode(body), status: response.status },
    );
  }
  if (typeof body !== "object" || body === null) {
    throw new OAuthTokenError("OAuth トークン応答の形式が不正です", { status: response.status });
  }
  return body as OAuthTokenResponse;
}

/**
 * アクセストークン（JWT）の `sub` を読む。
 *
 * **これは検証ではない。** 署名を確かめるのは API 側の責務であり（docs/auth.md §4）、
 * Worker はいま受け取ったばかりの、IdP から TLS 越しに直接来たトークンを読んでいるだけ。
 * ここで得た `sub` はログと運用のための識別子として KV に置く。
 */
function subjectOf(accessToken: string): string {
  const payload = accessToken.split(".")[1];
  if (!payload) throw new OAuthTokenError("アクセストークンの形式が不正です", { status: 0 });
  let claims: unknown;
  try {
    const json = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
    claims = JSON.parse(json);
  } catch (error) {
    throw new OAuthTokenError("アクセストークンを解析できません", { status: 0, cause: error });
  }
  const sub = (claims as { sub?: unknown }).sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new OAuthTokenError("アクセストークンに sub がありません", { status: 0 });
  }
  return sub;
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OAuthTokenError(`OAuth トークン応答に ${name} がありません`, { status: 0 });
  }
  return value;
}

/** `expires_in` が無い・壊れている場合は 0 を返し、呼び出し側でキャッシュさせない。 */
function readExpiresIn(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function getErrorCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const code = (body as { error?: unknown }).error;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function getErrorDescription(body: unknown): string {
  if (typeof body !== "object" || body === null) return "応答本文が不正です";
  const description = (body as { error_description?: unknown }).error_description;
  const code = (body as { error?: unknown }).error;
  if (typeof description === "string") return description;
  return typeof code === "string" ? code : "不明なエラー";
}
