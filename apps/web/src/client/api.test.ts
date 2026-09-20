import { expect, test } from "vitest";
import {
  ApiError,
  createRequestTracker,
  createSubmitGuard,
  fillActivityDays,
  putJson,
  requestJson,
} from "./api.js";

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

test("送信が終わるまで同じ Concept の再送信を受け付けない", async () => {
  const guard = createSubmitGuard();
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = guard.run("go.pointer", () => blocked);
  const second = await guard.run("go.pointer", async () => {
    throw new Error("二重送信してはいけない");
  });
  const other = await guard.run("go.defer", async () => undefined);
  release();

  expect(second).toBe(false);
  expect(other).toBe(true);
  await expect(first).resolves.toBe(true);
});

test("送信が失敗しても、その Concept はもう一度送信できる", async () => {
  const guard = createSubmitGuard();

  await expect(
    guard.run("go.pointer", async () => {
      throw new Error("保存に失敗");
    }),
  ).rejects.toThrow("保存に失敗");

  expect(guard.isRunning("go.pointer")).toBe(false);
  await expect(guard.run("go.pointer", async () => undefined)).resolves.toBe(true);
});

test("理解度の保存で 2xx でも JSON の解析に失敗したら利用不能エラーとして扱う", async () => {
  await expect(
    putJson(
      "/api/web/mastery-overrides",
      { conceptId: "go.pointer", status: "confirmed" },
      async () => new Response("not-json", { status: 200 }),
    ),
  ).rejects.toEqual(new ApiError("unavailable"));
});

test("理解度の保存が 401 で拒まれた理由を利用者が取れるエラー種別へ写像する", async () => {
  await expect(
    putJson(
      "/api/web/mastery-overrides",
      { conceptId: "go.pointer", status: "confirmed" },
      async () => Response.json({ error: "session_expired" }, { status: 401 }),
    ),
  ).rejects.toEqual(new ApiError("session_expired"));
});

test("送信中に弾かれた再送信は、実行中の送信の状態を巻き戻さない", async () => {
  const guard = createSubmitGuard();
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = guard.run("go.pointer", () => blocked);
  const stillRunningWhenBlocked = guard.isRunning("go.pointer");
  await guard.run("go.pointer", async () => undefined);
  const stillRunningAfterBlocked = guard.isRunning("go.pointer");
  release();
  await first;

  expect(stillRunningWhenBlocked).toBe(true);
  expect(stillRunningAfterBlocked).toBe(true);
  expect(guard.isRunning("go.pointer")).toBe(false);
});
