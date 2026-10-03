import { isIsoDateTime } from "@gakushu-sochi/domain";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "./api.js";
import {
  LEARNING_EVENTS_SYNC_PATH,
  WEB_CLIENT_ID,
  checkResultEvent,
  recordCheckResult,
} from "./check-result.js";

const NOW = new Date("2026-10-03T01:02:03.000Z");

function event(overview: boolean, practice: boolean) {
  return checkResultEvent({
    conceptId: "go.defer",
    correct: { overview, practice },
    id: "check-1",
    now: NOW,
  });
}

function syncResponse(status: string, extra: Record<string, unknown> = {}) {
  return Response.json({
    results: [{ index: 0, id: "check-1", status, ...extra }],
    summary: { accepted: 0, duplicate: 0, rejected: 0, [status]: 1 },
    historyResetAtMs: null,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("2問とも正解なら check_passed を組み立てる", () => {
  expect(event(true, true)).toEqual({
    id: "check-1",
    occurredAt: "2026-10-03T01:02:03.000Z",
    type: "check_passed",
    origin: "web",
    conceptIds: ["go.defer"],
  });
});

test.each([
  ["概要問題だけ正解", true, false],
  ["実践問題だけ正解", false, true],
  ["2問とも不正解", false, false],
])("%s なら check_failed にする", (_, overview, practice) => {
  expect(event(overview, practice).type).toBe("check_failed");
});

test("発生時刻は API の契約（オフセット必須の ISO 8601）を満たす", () => {
  expect(isIsoDateTime(event(true, true).occurredAt)).toBe(true);
});

test("回答内容を持たず、Concept と正誤だけを送る", async () => {
  let sent: unknown;
  const fetcher = vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return syncResponse("accepted");
  });

  await recordCheckResult(event(true, true), fetcher);

  expect(fetcher.mock.calls[0]?.[0]).toBe(LEARNING_EVENTS_SYNC_PATH);
  expect(fetcher.mock.calls[0]?.[1]?.method).toBe("POST");
  expect(sent).toEqual({ clientId: WEB_CLIENT_ID, events: [event(true, true)] });
});

test("受理されたら accepted を返す", async () => {
  await expect(
    recordCheckResult(event(true, true), async () => syncResponse("accepted")),
  ).resolves.toBe("accepted");
});

test("同じイベントの再送は duplicate として記録済み扱いにする", async () => {
  await expect(
    recordCheckResult(event(true, true), async () => syncResponse("duplicate")),
  ).resolves.toBe("duplicate");
});

test("送信と重なった学習データの削除に含まれたら、記録済みと区別して返す", async () => {
  // 受理されたが削除境界の内側に倒れ、保存されなかった（Issue #124）。
  await expect(
    recordCheckResult(event(true, true), async () =>
      syncResponse("accepted", { droppedByReset: true }),
    ),
  ).resolves.toBe("dropped_by_reset");
});

test("droppedByReset が false なら記録済みとして扱う", async () => {
  await expect(
    recordCheckResult(event(true, true), async () =>
      syncResponse("accepted", { droppedByReset: false }),
    ),
  ).resolves.toBe("accepted");
});

test("rejected は理由をログへ残して失敗にする", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(
    recordCheckResult(event(true, true), async () =>
      syncResponse("rejected", { reason: "conceptIds.0: invalid" }),
    ),
  ).rejects.toEqual(new ApiError("unavailable"));
  expect(log).toHaveBeenCalledWith(
    "check result was rejected by the API",
    expect.objectContaining({ eventId: "check-1", reason: "conceptIds.0: invalid" }),
  );
});

test.each([
  ["results が無い", {}],
  ["results が空", { results: [] }],
  ["別のイベントの結果", { results: [{ index: 0, id: "other", status: "accepted" }] }],
  ["status が無い", { results: [{ index: 0, id: "check-1" }] }],
  [
    "droppedByReset が boolean でない",
    { results: [{ index: 0, id: "check-1", status: "accepted", droppedByReset: "true" }] },
  ],
])("2xx でも応答が %s なら失敗にする", async (_, body) => {
  await expect(
    recordCheckResult(event(true, true), async () => Response.json(body)),
  ).rejects.toEqual(new ApiError("unavailable"));
});

test("同意が無ければ consent_required として伝える", async () => {
  await expect(
    recordCheckResult(event(true, true), async () =>
      Response.json({ error: "consent_required" }, { status: 403 }),
    ),
  ).rejects.toEqual(new ApiError("consent_required"));
});

test("ネットワーク断は unavailable として伝える", async () => {
  await expect(
    recordCheckResult(event(true, true), async () => {
      throw new TypeError("network");
    }),
  ).rejects.toEqual(new ApiError("unavailable"));
});
