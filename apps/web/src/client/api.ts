/**
 * 共有 `API_TOKEN` が無くなったので `api_token_invalid` は存在しない状態になった
 * （docs/auth.md §5.3）。代わりに `auth_unavailable` がある。これは IdP 側の
 * 一時的な失敗で、**セッションは生きている**ので再試行で直る。
 */
export type ApiErrorKind = "session_expired" | "auth_unavailable" | "rate_limited" | "unavailable";

export class ApiError extends Error {
  constructor(readonly kind: ApiErrorKind) {
    super(kind);
  }
}

export function createRequestTracker() {
  let latestRequestId = 0;
  return {
    start: () => {
      const requestId = ++latestRequestId;
      return () => requestId === latestRequestId;
    },
  };
}

export async function requestJson<T>(
  path: string,
  fetcher: typeof fetch = fetch,
  retrySessionOnce = false,
  wait: () => Promise<void> = () => new Promise((resolve) => window.setTimeout(resolve, 1_000)),
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(path, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new ApiError("unavailable");
  }
  if (retrySessionOnce && response.status === 401) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (body.error === "session_expired") {
      await wait();
      return requestJson(path, fetcher, false, wait);
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
  if (body.error === "session_expired") throw new ApiError("session_expired");
  if (body.error === "auth_unavailable") throw new ApiError("auth_unavailable");
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
 * 理解度の手動上書きを保存する。単発リクエストなので締め切りを設ける
 * （.agents/rules/rules.md RULE-001）。
 *
 * 2xx でも本文の解析に失敗したら失敗として扱う（RULE-004）。
 */
export async function putJson<T>(
  path: string,
  payload: unknown,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError("unavailable");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (body.error === "session_expired") throw new ApiError("session_expired");
    if (body.error === "auth_unavailable") throw new ApiError("auth_unavailable");
    if (response.status === 429) throw new ApiError("rate_limited");
    throw new ApiError("unavailable");
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError("unavailable");
  }
}
