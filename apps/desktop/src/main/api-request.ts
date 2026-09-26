import { describeApiFailure } from "./api-error.js";

/**
 * 認証付き JSON API 呼び出しの共通部品。
 *
 * すべての呼び出しで認証トークンを載せるため `redirect: "error"` と
 * タイムアウトを必須にする（RULE-001 / RULE-002）。
 * 2xx でも本文が JSON として読めなければ失敗として扱う（RULE-004）。
 */
export interface AuthedApiDeps {
  /** `${apiBaseUrl}/v1` まで。末尾スラッシュは呼び出し側で除く。 */
  baseUrl: string;
  getAccessToken: () => Promise<string>;
  fetch: typeof fetch;
  /** テスト差し替え用。既定 30 秒。 */
  timeoutMs?: number;
}

export const API_DEFAULT_TIMEOUT_MS = 30_000;

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

export async function authedApiRequest<T>(
  deps: AuthedApiDeps,
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const token = await deps.getAccessToken();
  const response = await deps.fetch(`${deps.baseUrl}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(deps.timeoutMs ?? API_DEFAULT_TIMEOUT_MS),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {
    // 2xx で本文が読めないのは失敗（RULE-004）。
    throw new ApiRequestError(
      response.status,
      `API 応答を解析できませんでした (${String(response.status)})。`,
    );
  }
  if (!response.ok) {
    throw new ApiRequestError(response.status, describeApiFailure(response.status, parsed));
  }
  return parsed as T;
}
