import { beforeEach, expect, test } from "vitest";
import { Hono } from "hono";
import type { LearningEvent } from "@gakushu-sochi/domain";
import { type AuthVariables } from "../auth/middleware.js";
import { TEST_TOKEN, stubAuth } from "../auth/test-auth.js";
import type { LearningActivityResponse } from "../contract/learning-activity.js";
import { InMemoryLearningEventRepository } from "../repository/memory.js";
import { createLearningActivityRoute } from "./learning-activity.js";

let events: InMemoryLearningEventRepository;
let app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;

/** 認証は `stubAuth` が担うので、env に資格情報は要らない。 */
const ENV = {};
const NOW = new Date("2026-09-06T12:00:00.000Z");

beforeEach(() => {
  events = new InMemoryLearningEventRepository();
  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth("user-a"));
  app.route(
    "/v1",
    createLearningActivityRoute(() => ({ events, now: () => NOW })),
  );
});

async function seed(userId: string, list: Partial<LearningEvent>[]) {
  await events.append(
    userId,
    list.map((partial, i) => ({
      event: {
        id: partial.id ?? `e${i}`,
        occurredAt: partial.occurredAt ?? "2026-09-06T00:00:00.000Z",
        type: partial.type ?? "solved_independently",
        origin: "vscode",
        conceptIds: partial.conceptIds ?? ["go.defer"],
      },
      clientId: "client-1",
      receivedAtMs: 0,
    })),
  );
}

async function getActivity(query = "") {
  return app.request(
    `/v1/learning-activity${query}`,
    { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    ENV as unknown as CloudflareBindings,
  );
}

test("UTC の日ごと・イベント種別ごとに集計し、観測のある日だけを返す", async () => {
  await seed("user-a", [
    { occurredAt: "2026-09-05T23:59:59.999Z", type: "hint_used" },
    { occurredAt: "2026-09-06T00:00:00.000Z", type: "solved_independently" },
    { occurredAt: "2026-09-06T10:00:00.000Z", type: "solved_independently" },
  ]);

  const response = await getActivity("?days=2");

  expect(response.status).toBe(200);
  expect((await response.json()) as LearningActivityResponse).toMatchObject({
    version: 1,
    derivedAt: NOW.toISOString(),
    from: "2026-09-05",
    to: "2026-09-06",
    days: [
      { date: "2026-09-05", counts: { hint_used: 1 } },
      { date: "2026-09-06", counts: { solved_independently: 2 } },
    ],
  });
});

test.each(["?days=0", "?days=366", "?days=1.5", "?days=abc", "?days=", "?days=7&days=30"])(
  "不正な days は 400 にする: %s",
  async (query) => {
    const response = await getActivity(query);

    expect(response.status).toBe(400);
  },
);

test("別ユーザーと指定期間外のイベントを返さない", async () => {
  await seed("user-a", [
    { occurredAt: "2026-08-30T23:59:59.999Z" },
    { occurredAt: "2026-09-06T12:00:00.000Z" },
  ]);
  await seed("user-b", [{ occurredAt: "2026-09-06T12:00:00.000Z" }]);

  const response = await getActivity("?days=7");
  const body = (await response.json()) as LearningActivityResponse;

  expect(body.from).toBe("2026-08-31");
  expect(body.days).toEqual([{ date: "2026-09-06", counts: { solved_independently: 1 } }]);
});

test("集計期間と derivedAt は同じ時点を基準にする", async () => {
  const nowValues = [new Date("2026-09-06T23:59:59.999Z"), new Date("2026-09-07T00:00:00.000Z")];
  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth("user-a"));
  app.route(
    "/v1",
    createLearningActivityRoute(() => ({ events, now: () => nowValues.shift()! })),
  );

  const body = (await (await getActivity("?days=1")).json()) as LearningActivityResponse;

  expect(body).toMatchObject({
    from: "2026-09-06",
    to: "2026-09-06",
    derivedAt: "2026-09-06T23:59:59.999Z",
  });
});
