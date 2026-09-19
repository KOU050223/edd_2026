import { expect, test } from "vitest";
import { ApiError, createRequestTracker, fillActivityDays, requestJson } from "./api.js";

test("API の 401 理由を利用者が取れるエラー種別へ写像する", async () => {
  await expect(
    requestJson("/api/v1/learning-profile", async () =>
      Response.json({ error: "session_expired" }, { status: 401 }),
    ),
  ).rejects.toEqual(new ApiError("session_expired"));
  await expect(
    requestJson("/api/v1/learning-profile", async () =>
      Response.json({ error: "api_token_invalid" }, { status: 401 }),
    ),
  ).rejects.toEqual(new ApiError("api_token_invalid"));
});

test("2xx でも JSON の解析に失敗したら利用不能エラーとして扱う", async () => {
  await expect(
    requestJson("/api/v1/learning-profile", async () => new Response("not-json", { status: 200 })),
  ).rejects.toEqual(new ApiError("unavailable"));
});

test("ログイン直後だけ、セッション未伝播の 401 を一度だけ再試行する", async () => {
  let calls = 0;
  const response = await requestJson<{ ok: boolean }>(
    "/api/v1/learning-profile",
    async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ error: "session_expired" }, { status: 401 })
        : Response.json({ ok: true });
    },
    true,
    async () => undefined,
  );

  expect(response).toEqual({ ok: true });
  expect(calls).toBe(2);
});

test("推移グラフ用に欠測日を 0 件で補完する", () => {
  expect(
    fillActivityDays({
      from: "2026-09-01",
      to: "2026-09-03",
      days: [{ date: "2026-09-02", counts: { hint_used: 2 } }],
    }),
  ).toEqual([
    { date: "2026-09-01", counts: {} },
    { date: "2026-09-02", counts: { hint_used: 2 } },
    { date: "2026-09-03", counts: {} },
  ]);
});

test("新しい要求が始まると古い要求の状態更新を許可しない", () => {
  const tracker = createRequestTracker();
  const firstIsLatest = tracker.start();
  const secondIsLatest = tracker.start();

  expect(firstIsLatest()).toBe(false);
  expect(secondIsLatest()).toBe(true);
});
