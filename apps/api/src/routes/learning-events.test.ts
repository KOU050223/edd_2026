import { beforeEach, expect, test } from "vitest";
import { Hono } from "hono";
import { type AuthVariables } from "../auth/middleware.js";
import { TEST_TOKEN, stubAuth } from "../auth/test-auth.js";
import {
  InMemoryIdentityRepository,
  InMemoryLearningEventRepository,
} from "../repository/memory.js";
import { createLearningEventsRoute } from "./learning-events.js";
import type { SyncResponse } from "../contract/learning-event.js";

let identity: InMemoryIdentityRepository;
let events: InMemoryLearningEventRepository;
let app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;

/** 認証は `stubAuth` が担うので、env に資格情報は要らない。 */
const ENV = {};

beforeEach(() => {
  identity = new InMemoryIdentityRepository();
  events = new InMemoryLearningEventRepository();

  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth("user-a"));
  app.route(
    "/v1",
    createLearningEventsRoute(() => ({ identity, events, now: () => 1000 })),
  );
});

function validEvent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    occurredAt: "2026-09-05T00:00:01.000Z",
    type: "solved_independently",
    origin: "vscode",
    conceptIds: ["go.defer"],
    ...overrides,
  };
}

async function sync(body: unknown, token = TEST_TOKEN) {
  const res = await app.request(
    "/v1/learning-events:sync",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    ENV as unknown as CloudflareBindings,
  );
  return res;
}

test("新規イベントを受理する", async () => {
  const res = await sync({ clientId: "client-1", events: [validEvent("e1")] });

  expect(res.status).toBe(200);
  const body = (await res.json()) as SyncResponse;
  expect(body.results).toEqual([{ index: 0, id: "e1", status: "accepted" }]);
  expect(body.summary).toEqual({ accepted: 1, duplicate: 0, rejected: 0 });
});

test("再送されたイベントは重複として返し、二重に記録しない", async () => {
  await sync({ clientId: "client-1", events: [validEvent("e1")] });
  const res = await sync({ clientId: "client-1", events: [validEvent("e1")] });

  const body = (await res.json()) as SyncResponse;
  expect(body.results[0]?.status).toBe("duplicate");
  expect(await events.countByUser("user-a")).toBe(1);
});

test("不正なイベントが混ざっても、同じバッチの正常なイベントは受理する", async () => {
  // オフラインキューの同期で1件の不正のためにバッチ全体を捨てない。
  const res = await sync({
    clientId: "client-1",
    events: [validEvent("e1"), { id: "broken" }, validEvent("e3")],
  });

  const body = (await res.json()) as SyncResponse;
  expect(body.results.map((r) => r.status)).toEqual(["accepted", "rejected", "accepted"]);
  expect(body.summary).toEqual({ accepted: 2, duplicate: 0, rejected: 1 });
  expect(await events.countByUser("user-a")).toBe(2);
});

test("結果は必ず入力と同じ順序・件数で返る", async () => {
  const res = await sync({
    clientId: "client-1",
    events: [{ id: "bad" }, validEvent("e2"), { nope: true }],
  });

  const body = (await res.json()) as SyncResponse;
  expect(body.results.map((r) => r.index)).toEqual([0, 1, 2]);
});

test("IDが読めない拒否でも位置は返す", async () => {
  // ID が null でも、クライアントは index で送信キューの項目を特定できる。
  const res = await sync({ clientId: "client-1", events: [{ nope: true }] });

  const body = (await res.json()) as SyncResponse;
  expect(body.results[0]).toMatchObject({ index: 0, id: null, status: "rejected" });
});

test("コード本文を含むイベントは拒否し、保存しない", async () => {
  const res = await sync({
    clientId: "client-1",
    events: [validEvent("e1", { sourceCode: "func main() {}" })],
  });

  const body = (await res.json()) as SyncResponse;
  expect(body.results[0]?.status).toBe("rejected");
  expect(await events.countByUser("user-a")).toBe(0);
});

test("occurredAtが解釈できないイベントは受理前に拒否する", async () => {
  // ここを通すと習熟度の導出が読み取りパスで例外を投げ、
  // GET /v1/learning-profile が永続的に500になる。
  const res = await sync({
    clientId: "client-1",
    events: [validEvent("e1", { occurredAt: "not-a-date" })],
  });

  const body = (await res.json()) as SyncResponse;
  expect(body.results[0]?.status).toBe("rejected");
  expect(await events.countByUser("user-a")).toBe(0);
});

test("同一リクエスト内でIDが重複していたら拒否する", async () => {
  // DBには1件しか入らないのに2件とも受理と応答すると、送信側は
  // 記録されなかったイベントを送信済みとみなしてしまう。
  const res = await sync({ clientId: "client-1", events: [validEvent("e1"), validEvent("e1")] });

  const body = (await res.json()) as SyncResponse;
  expect(body.results.map((r) => r.status)).toEqual(["accepted", "rejected"]);
  expect(await events.countByUser("user-a")).toBe(1);
});

test("イベントを保存する前にユーザーと端末を登録する", async () => {
  // learning_events は users(id) を参照しており、登録が無いと外部キー制約で落ちる。
  await sync({ clientId: "client-1", events: [validEvent("e1")] });

  expect(identity.users.has("user-a")).toBe(true);
  expect(identity.getDevice("user-a", "client-1")?.lastSeenAtMs).toBe(1000);
});

test("空のイベント配列でも成功し、登録は行わない", async () => {
  const res = await sync({ clientId: "client-1", events: [] });

  const body = (await res.json()) as SyncResponse;
  expect(body.summary).toEqual({ accepted: 0, duplicate: 0, rejected: 0 });
  expect(identity.users.size).toBe(0);
});

test("履歴が削除されていなければ、応答の削除時刻はnullを返す", async () => {
  // historyResetAtMs は DELETE /v1/learning-events を呼んでいない端末が
  // 削除へ追従するための手がかり（Issue #124）。削除済みかどうかは
  // learning-data.test.ts 側で確かめる。
  const res = await sync({ clientId: "client-1", events: [validEvent("e1")] });

  const body = (await res.json()) as SyncResponse;
  expect(body.historyResetAtMs).toBeNull();
});

test("エンベロープが不正なら400にする", async () => {
  const res = await sync({ events: [] });

  expect(res.status).toBe(400);
});

test("認証が無ければ401にし、保存しない", async () => {
  const res = await sync({ clientId: "client-1", events: [validEvent("e1")] }, "wrong");

  expect(res.status).toBe(401);
  expect(await events.countByUser("user-a")).toBe(0);
});

test("保存先は認証済みのユーザーで、ボディのclientIdでは決まらない", async () => {
  // clientId はクライアントの自己申告であり、認可の入力にしてはならない。
  await sync({ clientId: "someone-elses-client", events: [validEvent("e1")] });

  expect(await events.countByUser("user-a")).toBe(1);
  expect(await events.countByUser("someone-elses-client")).toBe(0);
});
