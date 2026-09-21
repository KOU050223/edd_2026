import { createHash, randomBytes } from "node:crypto";

const TOKEN_TIMEOUT_MS = 10_000;

export interface OAuthConfig {
  issuer: string;
  clientId: string;
  audience: string;
}

interface OAuthTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
}

/**
 * OAuth トークンエンドポイントが返したエラー。
 *
 * RFC 6749 の `error` コードを保持する。呼び出し側はメッセージ文字列ではなく
 * `code` で分類すること（無効・期限切れ・取り消し済みの refresh token は `invalid_grant`）。
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
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface RefreshedAccessToken {
  accessToken: string;
  refreshToken?: string;
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
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
    scope: "openid profile email offline_access",
    audience: config.audience,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export function parseCallbackUrl(callbackUrl: string, expectedState: string): string {
  const url = new URL(callbackUrl);
  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description");
    throw new Error(`OAuth 認可に失敗しました: ${description ?? error}`);
  }
  if (url.searchParams.get("state") !== expectedState) {
    throw new Error("OAuth state が一致しません。認可処理を中断しました。");
  }
  const code = url.searchParams.get("code");
  if (!code) throw new Error("OAuth 認可コードがありません。");
  return code;
}

export async function exchangeAuthorizationCode(
  config: OAuthConfig,
  code: string,
  redirectUri: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const body = await requestToken(
    config,
    {
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    },
    fetchImpl,
  );
  const accessToken = readString(body.access_token, "access_token");
  const refreshToken = readString(body.refresh_token, "refresh_token");
  return { accessToken, refreshToken };
}

export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshedAccessToken> {
  const body = await requestToken(
    config,
    {
      grant_type: "refresh_token",
      client_id: config.clientId,
      refresh_token: refreshToken,
    },
    fetchImpl,
  );
  const rotatedRefreshToken =
    typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? body.refresh_token
      : undefined;
  return {
    accessToken: readString(body.access_token, "access_token"),
    ...(rotatedRefreshToken ? { refreshToken: rotatedRefreshToken } : {}),
  };
}

/**
 * Refresh Token を IdP 側で撤回する（docs/auth.md §8）。
 *
 * **呼ぶ側は、これより先にローカルの Refresh Token を破棄していること。**
 * 利用者を守っているのはローカルの破棄であり、この撤回の成否ではない。
 * ここが失敗しても露出はアクセストークンの寿命（15分）に上限される。
 *
 * public client なので `client_secret` は送らない（送れない。配布物に隠せない）。
 * Auth0 は `token_endpoint_auth_method` が `none` のクライアントに対して、
 * `client_id` と `token` だけでの撤回を認めている。
 */
export async function revokeRefreshToken(
  config: OAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${config.issuer.replace(/\/$/, "")}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // 資格情報を載せるのでリダイレクトを追跡しない（.agents/rules/rules.md RULE-002）。
    redirect: "error",
    // 単発の外向きリクエスト。応答が返らないまま待ち続けない（RULE-001）。
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    body: JSON.stringify({ client_id: config.clientId, token: refreshToken }),
  });

  // 成功は 200。失敗を握りつぶさず、呼び出し側がログへ残せるよう投げる（RULE-004）。
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new OAuthTokenError(
      `OAuth トークンの撤回に失敗しました (${response.status}): ${detail.slice(0, 200)}`,
      { status: response.status },
    );
  }
}

async function requestToken(
  config: OAuthConfig,
  values: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<OAuthTokenResponse> {
  const response = await fetchImpl(`${config.issuer.replace(/\/$/, "")}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "error",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    body: new URLSearchParams(values),
  });
  const rawBody = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch (error) {
    throw new Error("OAuth トークン応答を解析できません", { cause: error });
  }
  if (!response.ok) {
    const detail = getErrorDescription(body);
    throw new OAuthTokenError(`OAuth トークン取得に失敗しました (${response.status}): ${detail}`, {
      code: getErrorCode(body),
      status: response.status,
    });
  }
  if (typeof body !== "object" || body === null) {
    throw new Error("OAuth トークン応答の形式が不正です。");
  }
  return body as OAuthTokenResponse;
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`OAuth トークン応答に ${name} がありません。`);
  }
  return value;
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
  return typeof description === "string"
    ? description
    : typeof code === "string"
      ? code
      : "不明なエラー";
}
