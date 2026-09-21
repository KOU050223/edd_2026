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
    interval: parsePositiveFiniteNumber(value.interval, "interval"),
  };
}

function parsePositiveFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new DeviceAuthError(`認証サーバーの ${field} が不正です`);
  }
  return value;
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
  private refreshPromise: Promise<string> | undefined;
  private authGeneration = 0;
  private loginInProgress = false;
  private storageOperation: Promise<void> = Promise.resolve();
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly secrets: Pick<vscode.SecretStorage, "get" | "store" | "delete">,
    options: DeviceAuthOptions = {},
  ) {
    this.sleep = options.sleep ?? wait;
  }

  async login(): Promise<void> {
    if (this.loginInProgress) throw new DeviceAuthError("ログイン中です");
    this.loginInProgress = true;
    this.authGeneration += 1;
    this.refreshPromise = undefined;
    const generation = this.authGeneration;
    try {
      const device = await this.requestDeviceCode();
      const opened = await vscode.env.openExternal(
        vscode.Uri.parse(device.verification_uri_complete ?? device.verification_uri),
      );
      if (!opened) throw new DeviceAuthError("ブラウザで認証ページを開けませんでした");
      void vscode.window.showInformationMessage(`Gakushu Sochi の認証コード: ${device.user_code}`);
      const token = await this.pollToken(device);
      await this.enqueueStorageOperation(async () => {
        this.assertAuthGeneration(generation);
        this.saveToken(token);
        this.assertAuthGeneration(generation);
        await this.storeRefreshToken(token);
        this.assertAuthGeneration(generation);
      });
    } finally {
      this.loginInProgress = false;
    }
  }

  async getAccessToken(): Promise<string> {
    if (this.loginInProgress) throw new DeviceAuthError("ログイン中です");
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 30_000) {
      return this.accessToken.value;
    }
    if (this.refreshPromise) return this.refreshPromise;

    const refreshPromise = this.refreshAccessToken();
    this.refreshPromise = refreshPromise;
    try {
      return await refreshPromise;
    } finally {
      if (this.refreshPromise === refreshPromise) this.refreshPromise = undefined;
    }
  }

  private async refreshAccessToken(): Promise<string> {
    const generation = this.authGeneration;
    const refreshToken = await this.enqueueStorageOperation(() =>
      this.secrets.get(REFRESH_TOKEN_KEY),
    );
    if (!refreshToken) throw new DeviceAuthError("再ログインが必要です");
    this.assertAuthGeneration(generation);

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
    this.assertAuthGeneration(generation);
    if (!response.ok) {
      if (this.oauthErrorCode(body) === "invalid_grant") {
        await this.clear();
        throw new DeviceAuthError("再ログインが必要です");
      }
      throw new DeviceAuthError(`トークン更新に失敗しました: ${this.oauthError(body)}`);
    }
    const token = parseToken(body);
    await this.enqueueStorageOperation(async () => {
      this.assertAuthGeneration(generation);
      this.saveToken(token);
      this.assertAuthGeneration(generation);
      await this.storeRefreshToken(token);
      this.assertAuthGeneration(generation);
    });
    return token.access_token;
  }

  async clear(): Promise<void> {
    this.authGeneration += 1;
    this.refreshPromise = undefined;
    this.accessToken = undefined;
    await this.enqueueStorageOperation(() => this.secrets.delete(REFRESH_TOKEN_KEY));
  }

  private assertAuthGeneration(generation: number): void {
    if (generation !== this.authGeneration) {
      throw new DeviceAuthError("再ログインが必要です");
    }
  }

  private async enqueueStorageOperation<T>(operation: () => PromiseLike<T>): Promise<T> {
    const queued = this.storageOperation.then(() => Promise.resolve(operation()));
    this.storageOperation = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  /**
   * ログアウトする（docs/auth.md §8）。
   *
   * **先にローカルの Refresh Token を破棄し、その後 `POST /oauth/revoke` を呼ぶ。**
   * 利用者を守っているのはローカルの破棄であり、撤回の成否ではない。順序が逆だと、
   * 撤回の通信で失敗したときに SecretStorage へトークンが残り、
   * ログアウトしたつもりの端末がログイン済みのままになる。
   *
   * 撤回の失敗は握りつぶさず記録するが、例外にはしない
   * （.agents/rules/rules.md RULE-004）。利用者から見たログアウトは
   * ローカルの破棄が終わった時点で既に成立しており、ここで投げると
   * 「ログアウトに失敗した」と表示され、実際には消えているのに
   * もう一度押させることになる。露出はアクセストークンの寿命（15分）に上限される。
   */
  async logout(): Promise<void> {
    // 破棄の前に読む。破棄してから読むと、撤回する対象が取れない。
    let refreshToken: string | undefined;
    try {
      refreshToken = await this.enqueueStorageOperation(() => this.secrets.get(REFRESH_TOKEN_KEY));
    } catch (error) {
      console.error("failed to read the refresh token before local logout", {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    await this.clear();

    if (!refreshToken) return;

    try {
      await this.revokeRefreshToken(refreshToken);
    } catch (error) {
      console.error("failed to revoke the refresh token after local logout", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * IdP 側で Refresh Token を撤回する。
   *
   * public client なので `client_secret` は送らない（配布物に隠せない）。
   * Auth0 は `token_endpoint_auth_method` が `none` のクライアントに対して、
   * `client_id` と `token` だけでの撤回を認めている。
   */
  private async revokeRefreshToken(refreshToken: string): Promise<void> {
    const response = await fetch(endpoint("/oauth/revoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, token: refreshToken }),
      // 資格情報を載せるのでリダイレクトを追跡しない（RULE-002）。
      redirect: "error",
      // 単発の外向きリクエスト。応答が返らないまま待ち続けない（RULE-001）。
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // 2xx 以外を成功に丸めない。呼び出し側が記録できるよう投げる（RULE-004）。
    if (!response.ok) {
      throw new DeviceAuthError(
        `トークンの撤回に失敗しました: ${this.oauthError(await responseJson(response).catch(() => undefined))}`,
      );
    }
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
