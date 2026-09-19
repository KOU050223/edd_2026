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
    throw new Error(`OAuth トークン取得に失敗しました (${response.status}): ${detail}`);
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
