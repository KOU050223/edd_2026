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
import {
  createInMemoryRepositoryStore,
  InMemoryIdentityRepository,
  InMemoryLearningEventRepository,
} from "../repository/memory.js";
import type { LearningProfileResponse } from "../contract/learning-profile.js";
import type { SyncResponse } from "../contract/learning-event.js";
import { createLearningDataRoute, type DeleteLearningEventsResponse } from "./learning-data.js";
import { createLearningEventsRoute } from "./learning-events.js";
import { createLearningProfileRoute } from "./learning-profile.js";

let identity: InMemoryIdentityRepository;
let events: InMemoryLearningEventRepository;
/** 現在時刻（epoch ミリ秒）。テストの中で進めて、削除の前後を作る。 */
let clockMs: number;
let app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;

/** 認証は `stubAuth` が担うので、env に資格情報は要らない。 */
const ENV = {} as unknown as CloudflareBindings;
const NOW = "2026-09-23T00:00:00.000Z";

/** 同じアプリに別人のトークンが届く本番の形のまま、他人のデータに触れないことを確かめる。 */
const TOKENS = { "token-a": "user-a", "token-b": "user-b" };

beforeEach(() => {
  // D1 と同じく1つのストアを共有させる。退会の CASCADE と同じで、
  // 片方だけ新しく作るとテスト実装だけが実際と違う振る舞いになる。
  const store = createInMemoryRepositoryStore();
  identity = new InMemoryIdentityRepository(store);
  events = new InMemoryLearningEventRepository(store);
  clockMs = 1_000;
  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth(TOKENS));
  // Profile と同じリポジトリを共有させる。削除が習熟度の導出へ反映されることを
  // 実際の GET /v1/learning-profile で確かめるため。
  app.route(
    "/v1",
    createLearningDataRoute(() => ({
      identity,
      events,
      nowIso: () => NOW,
      nowMs: () => clockMs,
    })),
  );
  // 同期との競合を実際のルート同士で再現するため、同期も同じアプリへ載せる。
  app.route(
    "/v1",
    createLearningEventsRoute(() => ({ identity, events, now: () => clockMs })),
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
    list.map((e) => ({ event: e, clientId: "client-1", receivedAtMs: clockMs })),
  );
}

function sync(token: string, list: LearningEvent[]) {
  return app.request(
    "/v1/learning-events:sync",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "client-1", events: list }),
    },
    ENV,
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

test("削除は自分のイベントを全件消し、件数と削除時刻を返す", async () => {
  await seed("user-a", [event({ id: "e1" }), event({ id: "e2" })]);

  const res = await request("/v1/learning-events", "token-a", "DELETE");

  expect(res.status).toBe(200);
  // resetAtMs は呼んだ端末が「適用済みの削除時刻」として記憶し、
  // 自分が呼んだ削除を同期応答で再度処理しないためのもの（Issue #124）。
  expect((await res.json()) as DeleteLearningEventsResponse).toEqual({
    deletedCount: 2,
    resetAtMs: 1_000,
  });
  expect(await events.countByUser("user-a")).toBe(0);
});

test("削除を再実行しても失敗しない", async () => {
  // 応答を受け取る前に切断された利用者が押し直しても、エラーにしない。
  await seed("user-a", [event({ id: "e1" })]);
  await request("/v1/learning-events", "token-a", "DELETE");

  const res = await request("/v1/learning-events", "token-a", "DELETE");

  expect(res.status).toBe(200);
  expect((await res.json()) as DeleteLearningEventsResponse).toEqual({
    deletedCount: 0,
    resetAtMs: 1_000,
  });
});

test("削除を呼んでいない端末は、同期応答の削除時刻で削除を知る", async () => {
  // 削除を呼んだ端末以外は DELETE を受け取る経路が無い。同期の応答に
  // 削除時刻を載せて、次回の同期でローカルのコピーを消せるようにする（Issue #124）。
  const res = await sync("token-a", [event({ id: "before-delete" })]);
  expect(((await res.json()) as SyncResponse).historyResetAtMs).toBeNull();

  await request("/v1/learning-events", "token-a", "DELETE");
  clockMs += 1;

  const after = await sync("token-a", [event({ id: "after-delete" })]);
  expect(((await after.json()) as SyncResponse).historyResetAtMs).toBe(1_000);
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

  expect((await res.json()) as DeleteLearningEventsResponse).toEqual({
    deletedCount: 1,
    resetAtMs: 1_000,
  });
  expect(await events.countByUser("user-b")).toBe(2);
  expect(await (await request("/v1/learning-profile", "token-b")).json()).toEqual(beforeB);
});

test("削除後に同期し直したイベントは新しい履歴として扱われる", async () => {
  // 削除した ID を冪等性の記録として残さない。残すと、削除済みの ID を
  // 永続的に保持することになり、「消した」ことにならない。
  await seed("user-a", [event({ id: "e1" })]);
  await request("/v1/learning-events", "token-a", "DELETE");
  clockMs += 1;

  const res = await sync("token-a", [event({ id: "e1" })]);

  expect(((await res.json()) as SyncResponse).results).toEqual([
    { index: 0, id: "e1", status: "accepted" },
  ]);
  expect(await events.countByUser("user-a")).toBe(1);
});

test("削除より前に受け取った同期は、書き込みが削除の後になっても履歴に残らない", async () => {
  // 同期は受信時刻を決めてから、ユーザー行の用意（I/O）を挟んで書き込む。
  // その隙間に削除が割り込むと、削除前に受け取ったイベントが削除後に INSERT される。
  // 利用者には「消した」と返した後で過去の履歴が残るので、これを塞ぐ。
  await seed("user-a", [event({ id: "old" })]);
  const original = identity.ensureUserAndDevice.bind(identity);
  identity.ensureUserAndDevice = async (params) => {
    await original(params);
    clockMs += 10;
    const res = await request("/v1/learning-events", "token-a", "DELETE");
    expect(res.status).toBe(200);
  };

  const res = await sync("token-a", [event({ id: "in-flight" })]);

  // 受理はする。受理したうえで削除に含まれた、という扱い。
  // 重複と答えると、既に保存されていたかのように見える。
  // droppedByReset で「受理したが書かなかった」を区別する。クライアントは
  // 追従後にこのイベントをローカルへ記録し直さない（Issue #124）。
  expect(res.status).toBe(200);
  expect(((await res.json()) as SyncResponse).results).toEqual([
    { index: 0, id: "in-flight", status: "accepted", droppedByReset: true },
  ]);
  expect(await events.countByUser("user-a")).toBe(0);
});

test("まだ一度も同期していない利用者の削除も、並行する初回の同期を塞ぐ", async () => {
  // users 行が無いからといって削除時刻の記録を省くと、並行して走っている
  // 初回の同期が削除の後に書き込む。
  const res = await request("/v1/learning-events", "token-a", "DELETE");
  expect((await res.json()) as DeleteLearningEventsResponse).toEqual({
    deletedCount: 0,
    resetAtMs: 1_000,
  });

  // 削除と同じ時刻に受け取ったイベントは境界の内側（書かない側）に倒す。
  await seed("user-a", [event({ id: "same-ms" })]);

  expect(await events.countByUser("user-a")).toBe(0);
  expect(identity.users.has("user-a")).toBe(true);
});

test("削除応答の削除時刻は、巻き戻らなかった記録後の実効値を返す", async () => {
  // deleteByUser は既存の削除時刻を巻き戻さない。時計の逆行などで
  // 既存値のほうが新しい場合、応答も新しい値を返さないと、呼んだ端末が
  // 古い「適用済み」を記録して次回同期で自分の削除へ二度追従する（Issue #124）。
  await events.deleteByUser("user-a", 2_000);
  clockMs = 1_500;

  const res = await request("/v1/learning-events", "token-a", "DELETE");

  expect(res.status).toBe(200);
  expect((await res.json()) as DeleteLearningEventsResponse).toEqual({
    deletedCount: 0,
    resetAtMs: 2_000,
  });
});

test("削除時刻は巻き戻らない", async () => {
  // 遅れて届いた古い削除要求で境界を後退させると、その間に受け取ったイベントが通る。
  await events.deleteByUser("user-a", 2_000);
  await events.deleteByUser("user-a", 1_500);
  clockMs = 1_800;

  await seed("user-a", [event({ id: "between" })]);

  expect(await events.countByUser("user-a")).toBe(0);
});

test("削除しても他人の同期は塞がない", async () => {
  await request("/v1/learning-events", "token-a", "DELETE");

  await seed("user-b", [event({ id: "b1" })]);

  expect(await events.countByUser("user-b")).toBe(1);
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
