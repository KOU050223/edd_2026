import { beforeEach, expect, test } from "vitest";
import { Hono } from "hono";
import {
  LEARNER_PROFILE_VERSION,
  deriveMasteryFromEvents,
  type LearnerProfile,
  type LearningEvent,
} from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import { stubAuth } from "../auth/test-auth.js";
import { InMemoryLearningEventRepository } from "../repository/memory.js";
import type { LearningProfileResponse } from "../contract/learning-profile.js";
import { createLearningDataRoute, type DeleteLearningEventsResponse } from "./learning-data.js";
import { createLearningProfileRoute } from "./learning-profile.js";

let events: InMemoryLearningEventRepository;
let app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;

/** 認証は `stubAuth` が担うので、env に資格情報は要らない。 */
const ENV = {} as unknown as CloudflareBindings;
const NOW = "2026-09-23T00:00:00.000Z";

/** 同じアプリに別人のトークンが届く本番の形のまま、他人のデータに触れないことを確かめる。 */
const TOKENS = { "token-a": "user-a", "token-b": "user-b" };

beforeEach(() => {
  events = new InMemoryLearningEventRepository();
  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth(TOKENS));
  // Profile と同じリポジトリを共有させる。削除が習熟度の導出へ反映されることを
  // 実際の GET /v1/learning-profile で確かめるため。
  app.route(
    "/v1",
    createLearningDataRoute(() => ({ events, nowIso: () => NOW })),
  );
  app.route(
    "/v1",
    createLearningProfileRoute(() => ({ events, nowIso: () => NOW })),
  );
});

function event(partial: Partial<LearningEvent> & { id: string }): LearningEvent {
  return {
    occurredAt: "2026-09-05T00:00:00.000Z",
    type: "solved_independently",
    origin: "vscode",
    conceptIds: ["go.defer"],
    ...partial,
  };
}

async function seed(userId: string, list: LearningEvent[]) {
  await events.append(
    userId,
    list.map((e) => ({ event: e, clientId: "client-1", receivedAtMs: 0 })),
  );
}

function request(path: string, token: string, method = "GET") {
  return app.request(path, { method, headers: { Authorization: `Bearer ${token}` } }, ENV);
}

test("エクスポートは自分のイベントを LearnerProfile の形で返す", async () => {
  const mine = [
    event({ id: "e1", occurredAt: "2026-09-05T00:00:00.000Z" }),
    event({ id: "e2", occurredAt: "2026-09-05T00:00:01.000Z", language: "go" }),
  ];
  await seed("user-a", mine);

  const res = await request("/v1/learning-events:export", "token-a");

  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = (await res.json()) as LearnerProfile;
  // 独自形式ではなく、クライアントの globalState と同じ形であること。
  expect(body).toEqual({
    version: LEARNER_PROFILE_VERSION,
    updatedAt: NOW,
    mastery: deriveMasteryFromEvents(mine),
    events: mine,
  });
});

test("イベントが無ければ空の LearnerProfile を返す", async () => {
  const res = await request("/v1/learning-events:export", "token-a");

  expect(res.status).toBe(200);
  const body = (await res.json()) as LearnerProfile;
  expect(body.events).toEqual([]);
  expect(body.mastery).toEqual({});
});

test("他人のイベントはエクスポートに含まれない", async () => {
  await seed("user-a", [event({ id: "mine" })]);
  // 同じイベント ID を他人も使っている。ID はグローバルに一意ではない。
  await seed("user-b", [
    event({ id: "mine", conceptIds: ["go.goroutine"] }),
    event({ id: "theirs" }),
  ]);

  const body = (await (
    await request("/v1/learning-events:export", "token-a")
  ).json()) as LearnerProfile;

  expect(body.events).toEqual([event({ id: "mine" })]);
  expect(Object.keys(body.mastery)).toEqual(["go.defer"]);
});

test("削除は自分のイベントを全件消し、件数を返す", async () => {
  await seed("user-a", [event({ id: "e1" }), event({ id: "e2" })]);

  const res = await request("/v1/learning-events", "token-a", "DELETE");

  expect(res.status).toBe(200);
  expect((await res.json()) as DeleteLearningEventsResponse).toEqual({ deletedCount: 2 });
  expect(await events.countByUser("user-a")).toBe(0);
});

test("削除を再実行しても失敗しない", async () => {
  // 応答を受け取る前に切断された利用者が押し直しても、エラーにしない。
  await seed("user-a", [event({ id: "e1" })]);
  await request("/v1/learning-events", "token-a", "DELETE");

  const res = await request("/v1/learning-events", "token-a", "DELETE");

  expect(res.status).toBe(200);
  expect((await res.json()) as DeleteLearningEventsResponse).toEqual({ deletedCount: 0 });
});

test("削除後、learning-profile の習熟度から消したイベントの寄与が消える", async () => {
  await seed("user-a", [
    event({ id: "e1", conceptIds: ["go.defer"] }),
    event({ id: "e2", conceptIds: ["go.defer", "go.goroutine"] }),
  ]);
  const before = (await (
    await request("/v1/learning-profile", "token-a")
  ).json()) as LearningProfileResponse;
  expect(before.concepts.length).toBeGreaterThan(0);

  await request("/v1/learning-events", "token-a", "DELETE");

  // 習熟度は保存値ではなくイベントから導出する正本なので、イベントを消せば
  // 習熟度も消える。スナップショットを持つ実装に変わったら、ここが落ちる。
  const after = (await (
    await request("/v1/learning-profile", "token-a")
  ).json()) as LearningProfileResponse;
  expect(after.concepts).toEqual([]);
  expect(after.eventCount).toBe(0);
});

test("削除しても他人のイベントと習熟度は残る", async () => {
  await seed("user-a", [event({ id: "shared-id" })]);
  await seed("user-b", [event({ id: "shared-id" }), event({ id: "b2" })]);
  const beforeB = await (await request("/v1/learning-profile", "token-b")).json();

  const res = await request("/v1/learning-events", "token-a", "DELETE");

  expect((await res.json()) as DeleteLearningEventsResponse).toEqual({ deletedCount: 1 });
  expect(await events.countByUser("user-b")).toBe(2);
  expect(await (await request("/v1/learning-profile", "token-b")).json()).toEqual(beforeB);
});

test("削除後に同期し直したイベントは新しい履歴として扱われる", async () => {
  // 削除した ID を冪等性の記録として残さない。残すと、削除済みの ID を
  // 永続的に保持することになり、「消した」ことにならない。
  await seed("user-a", [event({ id: "e1" })]);
  await request("/v1/learning-events", "token-a", "DELETE");

  const [result] = await events.append("user-a", [
    { event: event({ id: "e1" }), clientId: "client-1", receivedAtMs: 0 },
  ]);

  expect(result).toEqual({ id: "e1", duplicate: false });
});

test.each([
  ["GET", "/v1/learning-events:export"],
  ["DELETE", "/v1/learning-events"],
])("%s %s は認証が無ければ 401 を返し、何も消さない", async (method, path) => {
  await seed("user-a", [event({ id: "e1" })]);

  const res = await app.request(path, { method }, ENV);

  expect(res.status).toBe(401);
  expect(await events.countByUser("user-a")).toBe(1);
});
