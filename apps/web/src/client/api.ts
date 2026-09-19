export type ApiErrorKind = "session_expired" | "api_token_invalid" | "rate_limited" | "unavailable";

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
    response = await fetcher(path, { cache: "no-store" });
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
  if (body.error === "api_token_invalid") throw new ApiError("api_token_invalid");
  if (response.status === 429) throw new ApiError("rate_limited");
  throw new ApiError("unavailable");
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
