import { expect, test } from "vitest";
import { ApiError } from "./api.js";
import {
  eventTypeLabel,
  fetchConversationLearningEvents,
  formatObjectiveDelta,
  groupChangesByConcept,
} from "./conversation-learning.js";

const validEvent = {
  id: "e1",
  type: "question_asked",
  occurredAt: "2026-10-01T00:00:00.000Z",
  changes: [
    {
      conceptId: "go.defer",
      conceptLabel: "defer",
      objectiveId: "go.defer:lifo_order",
      objectiveLabel: "複数あるときの実行順（登録の逆順）",
      before: 0,
      after: 0.05,
    },
  ],
};

test("会話 ID を URL エンコードして取り、イベントの一覧を返す", async () => {
  let requested: unknown;
  const events = await fetchConversationLearningEvents(
    async (input) => {
      requested = input;
      return Response.json({ version: 1, events: [validEvent] });
    },
    0,
    "a/b",
  );

  expect(requested).toBe("/api/v1/conversations/a%2Fb/learning-events");
  expect(events).toEqual([validEvent]);
});

test("2xx でも形が違えば失敗にする", async () => {
  const respond = (body: unknown) =>
    fetchConversationLearningEvents(async () => Response.json(body), 0, "c");

  await expect(respond({ version: 1 })).rejects.toEqual(new ApiError("unavailable"));
  await expect(
    respond({ version: 1, events: [{ ...validEvent, type: "unknown_type" }] }),
  ).rejects.toEqual(new ApiError("unavailable"));
  await expect(
    respond({ version: 1, events: [{ ...validEvent, changes: [{ conceptId: "go.defer" }] }] }),
  ).rejects.toEqual(new ApiError("unavailable"));
});

test("加算幅は小数2桁で符号つき、動かなければ ±0", () => {
  expect(formatObjectiveDelta({ before: 0.1, after: 0.15 })).toBe("+0.05");
  expect(formatObjectiveDelta({ before: 0.5, after: 1 })).toBe("+0.50");
  expect(formatObjectiveDelta({ before: 0.3, after: 0.05 })).toBe("−0.25");
  expect(formatObjectiveDelta({ before: 0.5, after: 0.5 })).toBe("±0");
});

test("イベント種別の表示名", () => {
  expect(eventTypeLabel("question_asked")).toBe("質問した");
  expect(eventTypeLabel("solved_independently")).toBe("自力で解決した");
});

test("変化を Concept ごとにまとめ、ラベルが無ければ ID を出す", () => {
  const groups = groupChangesByConcept([
    validEvent.changes[0]!,
    { ...validEvent.changes[0]!, conceptId: "go.slice", conceptLabel: undefined },
    { ...validEvent.changes[0]!, objectiveId: "go.defer:execution_timing" },
  ]);

  expect(groups.map((group) => [group.conceptLabel, group.changes.length])).toEqual([
    ["defer", 2],
    ["go.slice", 1],
  ]);
});
