/**
 * 共有 `API_TOKEN` が無くなったので `api_token_invalid` は存在しない状態になった
 * （docs/auth.md §5.3）。代わりに `auth_unavailable` がある。これは IdP 側の
 * 一時的な失敗で、**セッションは生きている**ので再試行で直る。
 */
export type ApiErrorKind =
  | "login_required"
  | "session_expired"
  | "auth_unavailable"
  | "rate_limited"
  | "consent_required"
  | "consent_outdated"
  | "unavailable";

export class ApiError extends Error {
  constructor(readonly kind: ApiErrorKind) {
    super(kind);
  }
}

export async function requestJson<T>(
  path: string,
  fetcher: typeof fetch = fetch,
  sessionRetries: boolean | number = false,
  wait: () => Promise<void> = () => new Promise((resolve) => window.setTimeout(resolve, 1_000)),
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(path, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new ApiError("unavailable");
  }
  const remainingRetries =
    typeof sessionRetries === "boolean" ? (sessionRetries ? 1 : 0) : sessionRetries;
  if (remainingRetries > 0 && response.status === 401) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (body.error === "session_expired") {
      await wait();
      return requestJson(path, fetcher, remainingRetries - 1, wait);
    }
  }
  if (response.ok) {
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError("unavailable");
    }
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (body.error === "login_required") throw new ApiError("login_required");
  if (body.error === "session_expired") throw new ApiError("session_expired");
  if (body.error === "auth_unavailable") throw new ApiError("auth_unavailable");
  if (body.error === "consent_required") throw new ApiError("consent_required");
  if (response.status === 429) throw new ApiError("rate_limited");
  throw new ApiError("unavailable");
}

export function createOperationQueue() {
  let tail = Promise.resolve();
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const result = tail.then(operation);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

export interface ActivityDay {
  date: string;
  counts: Record<string, number>;
}
export function fillActivityDays(activity: {
  from: string;
  to: string;
  days: ActivityDay[];
}): ActivityDay[] {
  const known = new Map(activity.days.map((day) => [day.date, day]));
  const values: ActivityDay[] = [];
  for (
    let date = new Date(`${activity.from}T00:00:00Z`);
    date <= new Date(`${activity.to}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    const key = date.toISOString().slice(0, 10);
    values.push(known.get(key) ?? { date: key, counts: {} });
  }
  return values;
}

/**
 * 送信中の再送信を状態で止める（.agents/rules/rules.md RULE-007）。
 *
 * ボタンの `disabled` は見た目でしかなく、キーボードや別経路からの呼び出しは素通りする。
 * 入口で状態を見て弾くのが本体。解除は `finally` で行い、失敗しても必ず戻す。
 */
export function createSubmitGuard() {
  const running = new Set<string>();
  return {
    isRunning: (key: string) => running.has(key),
    run: async (key: string, task: () => Promise<void>): Promise<boolean> => {
      if (running.has(key)) return false;
      running.add(key);
      try {
        await task();
      } finally {
        running.delete(key);
      }
      return true;
    },
  };
}

/**
 * 単発の書き込みリクエスト。締め切りを設ける（.agents/rules/rules.md RULE-001）。
 *
 * 2xx でも本文の解析に失敗したら失敗として扱う（RULE-004）。
 */
async function sendJson<T>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  payload: unknown,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(path, {
      method,
      ...(payload !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }
        : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError("unavailable");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (body.error === "login_required") throw new ApiError("login_required");
    if (body.error === "session_expired") throw new ApiError("session_expired");
    if (body.error === "auth_unavailable") throw new ApiError("auth_unavailable");
    if (body.error === "consent_required") throw new ApiError("consent_required");
    if (response.status === 429) throw new ApiError("rate_limited");
    throw new ApiError("unavailable");
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError("unavailable");
  }
}

/** 理解度の手動上書きを保存する。 */
export function putJson<T>(
  path: string,
  payload: unknown,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<T> {
  return sendJson("PUT", path, payload, fetcher, timeoutMs);
}

/**
 * 本文を持たない POST を送る。
 *
 * サーバー側で判定して記録する経路（分野コンプリートの判定）に使う。
 * 送る値が無くても GET にしない。記録を書きうるためである。
 */
export function postJson<T>(path: string, fetcher: typeof fetch = fetch, timeoutMs = 10_000) {
  return sendJson<T>("POST", path, undefined, fetcher, timeoutMs);
}

/** 学習データの削除など、本文を持たない DELETE を送る。 */
export function deleteJson<T>(
  path: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<T> {
  return sendJson("DELETE", path, undefined, fetcher, timeoutMs);
}
