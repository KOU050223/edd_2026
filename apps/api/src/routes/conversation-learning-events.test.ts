import { beforeEach, expect, test } from "vitest";
import { Hono } from "hono";
import type { LearningEvent } from "@gakushu-sochi/domain";
import { type AuthVariables } from "../auth/middleware.js";
import { TEST_TOKEN, stubAuth } from "../auth/test-auth.js";
import {
  InMemoryLearningEventRepository,
  createInMemoryRepositoryStore,
  InMemoryLearningMapRepository,
} from "../repository/memory.js";
import { createConversationLearningEventsRoute } from "./conversation-learning-events.js";
import type { ConversationLearningEventsResponse } from "../contract/conversation-learning-events.js";
import { seedTestMap, TEST_MAP_NODE, TEST_MAP_OBJECTIVES } from "../maps/test-map.js";
import { migratedFixedObjectives } from "../maps/test-fixed-objectives.js";

let events: InMemoryLearningEventRepository;
let maps: InMemoryLearningMapRepository;
let app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;

const ENV = {};

beforeEach(() => {
  const store = createInMemoryRepositoryStore();
  // 固定の Concept の項目は D1 の表にある（#245）。マイグレーションで入れた Go の項目を入れる。
  store.fixedObjectives.push(...migratedFixedObjectives());
  events = new InMemoryLearningEventRepository(store);
  maps = new InMemoryLearningMapRepository(store);
  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth("user-a"));
  app.route(
    "/v1",
    createConversationLearningEventsRoute(() => ({ events, maps })),
  );
});

let sequence = 0;

async function seed(userId: string, list: Partial<LearningEvent>[]) {
  await events.append(
    userId,
    list.map((partial) => {
      sequence += 1;
      return {
        event: {
          id: partial.id ?? `e${sequence}`,
          occurredAt: new Date(Date.UTC(2026, 9, 1, 0, 0, sequence)).toISOString(),
          type: partial.type ?? "question_asked",
          origin: "vscode",
          conceptIds: partial.conceptIds ?? ["go.defer"],
          ...(partial.objectiveIds === undefined ? {} : { objectiveIds: partial.objectiveIds }),
          ...(partial.sessionId === undefined ? {} : { sessionId: partial.sessionId }),
        },
        clientId: "client-1",
        receivedAtMs: 0,
      };
    }),
  );
}

async function getLearningEvents(conversationId: string) {
  const res = await app.request(
    `/v1/conversations/${conversationId}/learning-events`,
    { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    ENV as unknown as CloudflareBindings,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ConversationLearningEventsResponse;
}

test("会話で項目を動かしたイベントを、Concept・項目名・前後の値つきで返す", async () => {
  // 以前の会話で 0.5 まで上げておく。加算幅は過去のイベントに依存する。
  await seed(
    "user-a",
    Array.from({ length: 10 }, () => ({
      objectiveIds: ["go.defer:execution_timing"],
      sessionId: "earlier",
    })),
  );
  await seed("user-a", [
    {
      id: "asked",
      objectiveIds: ["go.defer:execution_timing", "go.defer:lifo_order"],
      sessionId: "conv-1",
    },
    { id: "viewed", type: "answer_viewed", sessionId: "conv-1" },
    {
      id: "solved",
      type: "solved_independently",
      objectiveIds: ["go.defer:execution_timing"],
      sessionId: "conv-1",
    },
  ]);

  const body = await getLearningEvents("conv-1");

  expect(body.version).toBe(1);
  // 項目に触れていない answer_viewed は含めない。
  expect(body.events.map((event) => [event.id, event.type])).toEqual([
    ["asked", "question_asked"],
    ["solved", "solved_independently"],
  ]);
  expect(body.events[0]?.changes).toEqual([
    {
      conceptId: "go.defer",
      conceptLabel: expect.any(String),
      objectiveId: "go.defer:execution_timing",
      objectiveLabel: "実行タイミング（関数を抜けるとき）",
      before: 0.5,
      after: 0.5,
    },
    {
      conceptId: "go.defer",
      conceptLabel: expect.any(String),
      objectiveId: "go.defer:lifo_order",
      objectiveLabel: "複数あるときの実行順（登録の逆順）",
      before: 0,
      after: 0.05,
    },
  ]);
  expect(body.events[1]?.changes).toEqual([
    expect.objectContaining({ objectiveId: "go.defer:execution_timing", before: 0.5, after: 1 }),
  ]);
});

test("項目の情報を持たないイベントしか無ければ空を返す", async () => {
  await seed("user-a", [
    { sessionId: "conv-1" },
    { objectiveIds: ["go.defer:unknown_key"], sessionId: "conv-1" },
    // 項目を持たない Concept（ts.*）。
    { conceptIds: ["ts.type_narrowing"], sessionId: "conv-1" },
  ]);

  expect((await getLearningEvents("conv-1")).events).toEqual([]);
});

test("他の利用者のイベントは返さない", async () => {
  await seed("user-b", [{ objectiveIds: ["go.defer:lifo_order"], sessionId: "conv-1" }]);

  expect((await getLearningEvents("conv-1")).events).toEqual([]);
});

test("手で作ったマップのノードの項目も、Concept 名・項目名つきで返す（#242）", async () => {
  await seedTestMap(maps, "user-a");
  const [move] = TEST_MAP_OBJECTIVES;
  await seed("user-a", [
    { id: "asked", conceptIds: [TEST_MAP_NODE.id], objectiveIds: [move!.id], sessionId: "conv-1" },
  ]);

  const body = await getLearningEvents("conv-1");
  expect(body.events).toEqual([
    expect.objectContaining({
      id: "asked",
      changes: [
        {
          conceptId: TEST_MAP_NODE.id,
          conceptLabel: TEST_MAP_NODE.label,
          objectiveId: move!.id,
          objectiveLabel: move!.label,
          before: 0,
          after: 0.05,
        },
      ],
    }),
  ]);
});
