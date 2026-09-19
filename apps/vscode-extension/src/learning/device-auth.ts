import * as vscode from "vscode";

const ISSUER = "https://gakushu-sochi.jp.auth0.com";
const CLIENT_ID = "QkzWUVBYTbVYoye8SbHxaKbam6sSj014";
const AUDIENCE = "https://api.gakushu-sochi.dev";
const REFRESH_TOKEN_KEY = "gakushuSochi.auth.refreshToken";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_SECONDS = 5;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

export class DeviceAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceAuthError";
  }
}

function endpoint(path: string): string {
  return `${ISSUER}${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseDeviceCode(value: unknown): DeviceCodeResponse {
  if (
    !isRecord(value) ||
    typeof value.device_code !== "string" ||
    typeof value.user_code !== "string" ||
    typeof value.verification_uri !== "string" ||
    typeof value.expires_in !== "number"
  ) {
    throw new DeviceAuthError("認証サーバーのデバイスコード応答が不正です");
  }
  return {
    device_code: value.device_code,
    user_code: value.user_code,
    verification_uri: value.verification_uri,
    verification_uri_complete:
      typeof value.verification_uri_complete === "string"
        ? value.verification_uri_complete
        : undefined,
    expires_in: value.expires_in,
    interval: typeof value.interval === "number" ? value.interval : undefined,
  };
}

function parseToken(value: unknown): TokenResponse {
  if (
    !isRecord(value) ||
    typeof value.access_token !== "string" ||
    typeof value.token_type !== "string" ||
    typeof value.expires_in !== "number"
  ) {
    throw new DeviceAuthError("認証サーバーのトークン応答が不正です");
  }
  return {
    access_token: value.access_token,
    token_type: value.token_type,
    expires_in: value.expires_in,
    refresh_token: typeof value.refresh_token === "string" ? value.refresh_token : undefined,
  };
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new DeviceAuthError(`認証サーバーの応答を解析できません: ${String(error)}`);
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export interface DeviceAuthOptions {
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Auth0 Device Authorization Grant を扱う。アクセストークンはこのインスタンス内だけに保持する。 */
export class DeviceAuth {
  private accessToken: { value: string; expiresAt: number } | undefined;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly secrets: Pick<vscode.SecretStorage, "get" | "store" | "delete">,
    options: DeviceAuthOptions = {},
  ) {
    this.sleep = options.sleep ?? wait;
  }

  async login(): Promise<void> {
    const device = await this.requestDeviceCode();
    const opened = await vscode.env.openExternal(
      vscode.Uri.parse(device.verification_uri_complete ?? device.verification_uri),
    );
    if (!opened) throw new DeviceAuthError("ブラウザで認証ページを開けませんでした");
    void vscode.window.showInformationMessage(`Gakushu Sochi の認証コード: ${device.user_code}`);
    const token = await this.pollToken(device);
    this.saveToken(token);
    await this.storeRefreshToken(token);
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 30_000) {
      return this.accessToken.value;
    }
    const refreshToken = await this.secrets.get(REFRESH_TOKEN_KEY);
    if (!refreshToken) throw new DeviceAuthError("再ログインが必要です");

    let response: Response;
    try {
      response = await fetch(endpoint("/oauth/token"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: CLIENT_ID,
          refresh_token: refreshToken,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new DeviceAuthError(`トークン更新に失敗しました: ${String(error)}`);
    }
    const body = await responseJson(response);
    if (!response.ok) {
      if (this.oauthErrorCode(body) === "invalid_grant") {
        await this.clear();
        throw new DeviceAuthError("再ログインが必要です");
      }
      throw new DeviceAuthError(`トークン更新に失敗しました: ${this.oauthError(body)}`);
    }
    const token = parseToken(body);
    this.saveToken(token);
    await this.storeRefreshToken(token);
    return token.access_token;
  }

  async clear(): Promise<void> {
    this.accessToken = undefined;
    await this.secrets.delete(REFRESH_TOKEN_KEY);
  }

  private async requestDeviceCode(): Promise<DeviceCodeResponse> {
    let response: Response;
    try {
      response = await fetch(endpoint("/oauth/device/code"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          scope: "openid profile email offline_access",
          audience: AUDIENCE,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new DeviceAuthError(`デバイス認証を開始できません: ${String(error)}`);
    }
    const body = await responseJson(response);
    if (!response.ok)
      throw new DeviceAuthError(`デバイス認証を開始できません: ${this.oauthError(body)}`);
    return parseDeviceCode(body);
  }

  private async pollToken(device: DeviceCodeResponse): Promise<TokenResponse> {
    const deadline = Date.now() + device.expires_in * 1_000;
    let interval = device.interval ?? DEFAULT_INTERVAL_SECONDS;
    while (Date.now() < deadline) {
      await this.sleep(interval * 1_000);
      let response: Response;
      try {
        response = await fetch(endpoint("/oauth/token"), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: device.device_code,
            client_id: CLIENT_ID,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new DeviceAuthError(`トークン取得に失敗しました: ${String(error)}`);
      }
      const body = await responseJson(response);
      if (response.ok) return parseToken(body);
      const error = this.oauthErrorCode(body);
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        interval += SLOW_DOWN_SECONDS;
        continue;
      }
      if (error === "access_denied" || error === "expired_token") {
        throw new DeviceAuthError("認証が完了しなかったため、もう一度ログインしてください");
      }
      throw new DeviceAuthError(`認証に失敗しました: ${this.oauthError(body)}`);
    }
    throw new DeviceAuthError("認証の有効期限が切れました。もう一度ログインしてください");
  }

  private saveToken(token: TokenResponse): void {
    this.accessToken = {
      value: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1_000,
    };
  }

  private async storeRefreshToken(token: TokenResponse): Promise<void> {
    if (token.refresh_token) await this.secrets.store(REFRESH_TOKEN_KEY, token.refresh_token);
  }

  private oauthErrorCode(value: unknown): string {
    return isRecord(value) && typeof value.error === "string" ? value.error : "unknown";
  }

  private oauthError(value: unknown): string {
    if (!isRecord(value)) return "unknown";
    const error = typeof value.error === "string" ? value.error : "unknown";
    const description =
      typeof value.error_description === "string" ? `: ${value.error_description}` : "";
    return `${error}${description}`;
  }
}
