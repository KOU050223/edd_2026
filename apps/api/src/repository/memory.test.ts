import { beforeEach, expect, test } from "vitest";
import type { LearningEvent } from "@gakushu-sochi/domain";
import {
  createInMemoryRepositoryStore,
  InMemoryIdentityRepository,
  InMemoryLearningEventRepository,
} from "./memory.js";
import type { StoredEventInput } from "./types.js";

let repo: InMemoryLearningEventRepository;

beforeEach(() => {
  repo = new InMemoryLearningEventRepository();
});

function input(id: string, occurredAt: string, clientId = "client-1"): StoredEventInput {
  const event: LearningEvent = {
    id,
    occurredAt,
    type: "solved_independently",
    origin: "vscode",
    conceptIds: ["go.defer"],
  };
  return { event, clientId, receivedAtMs: 0 };
}

test("新規イベントを受理する", async () => {
  const results = await repo.append("user-a", [input("e1", "2026-09-05T00:00:01.000Z")]);

  expect(results).toEqual([{ id: "e1", duplicate: false }]);
});

test("同一ユーザーの同じIDは重複として扱い、上書きしない", async () => {
  await repo.append("user-a", [input("e1", "2026-09-05T00:00:01.000Z")]);
  const results = await repo.append("user-a", [input("e1", "2026-09-05T00:00:09.000Z")]);

  expect(results).toEqual([{ id: "e1", duplicate: true }]);

  // 追記のみで書き換えないため、後着の再送で内容は変わらない。
  const events = await repo.listByUser("user-a");
  expect(events).toHaveLength(1);
  expect(events[0]?.occurredAt).toBe("2026-09-05T00:00:01.000Z");
});

test("別ユーザーの同じIDは衝突しない", async () => {
  // イベントIDはクライアント生成で、グローバルには一意でない。
  // ここが衝突すると、他人のイベントを黙って捨てたうえで「重複（再送の正常系）」
  // として応答してしまう。
  await repo.append("user-a", [input("event-1", "2026-09-05T00:00:01.000Z")]);
  const results = await repo.append("user-b", [input("event-1", "2026-09-05T00:00:02.000Z")]);

  expect(results).toEqual([{ id: "event-1", duplicate: false }]);
  expect(await repo.countByUser("user-a")).toBe(1);
  expect(await repo.countByUser("user-b")).toBe(1);
});

test("結果は入力と同じ順序で返る", async () => {
  await repo.append("user-a", [input("e2", "2026-09-05T00:00:02.000Z")]);

  const results = await repo.append("user-a", [
    input("e1", "2026-09-05T00:00:01.000Z"),
    input("e2", "2026-09-05T00:00:02.000Z"),
    input("e3", "2026-09-05T00:00:03.000Z"),
  ]);

  expect(results).toEqual([
    { id: "e1", duplicate: false },
    { id: "e2", duplicate: true },
    { id: "e3", duplicate: false },
  ]);
});

test("発生時刻の昇順で読み出す", async () => {
  await repo.append("user-a", [
    input("e3", "2026-09-05T00:00:03.000Z"),
    input("e1", "2026-09-05T00:00:01.000Z"),
    input("e2", "2026-09-05T00:00:02.000Z"),
  ]);

  const events = await repo.listByUser("user-a");

  expect(events.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
});

test("同時刻はIDの昇順で読み出す", async () => {
  const sameTime = "2026-09-05T00:00:00.000Z";
  await repo.append("user-a", [input("b", sameTime), input("a", sameTime)]);

  const events = await repo.listByUser("user-a");

  expect(events.map((e) => e.id)).toEqual(["a", "b"]);
});

test("タイムゾーン表記が違っても実時刻の順で読み出す", async () => {
  // 09:00+09:00 は 00:00Z と同時刻。文字列の辞書順で並べると逆になる。
  await repo.append("user-a", [
    input("e2", "2026-09-05T09:00:01+09:00"),
    input("e1", "2026-09-05T00:00:00.000Z"),
  ]);

  const events = await repo.listByUser("user-a");

  expect(events.map((e) => e.id)).toEqual(["e1", "e2"]);
});

test("イベントの無いユーザーは空を返す", async () => {
  expect(await repo.listByUser("unknown")).toEqual([]);
  expect(await repo.countByUser("unknown")).toBe(0);
});

test("空の入力を受け付ける", async () => {
  expect(await repo.append("user-a", [])).toEqual([]);
});

test("ユーザーと端末を登録し、既存なら重複させない", async () => {
  const identity = new InMemoryIdentityRepository();

  await identity.ensureUserAndDevice({ userId: "user-a", clientId: "client-1", nowMs: 100 });
  await identity.ensureUserAndDevice({ userId: "user-a", clientId: "client-1", nowMs: 200 });

  expect(identity.users.size).toBe(1);
  expect(identity.deviceCount).toBe(1);
});

test("同期のたびに端末の最終同期時刻を更新する", async () => {
  const identity = new InMemoryIdentityRepository();

  await identity.ensureUserAndDevice({ userId: "user-a", clientId: "client-1", nowMs: 100 });
  await identity.ensureUserAndDevice({ userId: "user-a", clientId: "client-1", nowMs: 999 });

  expect(identity.getDevice("user-a", "client-1")?.lastSeenAtMs).toBe(999);
});

test("作成時刻は登録し直しても上書きしない", async () => {
  const identity = new InMemoryIdentityRepository();

  await identity.ensureUserAndDevice({ userId: "user-a", clientId: "client-1", nowMs: 100 });
  await identity.ensureUserAndDevice({ userId: "user-a", clientId: "client-1", nowMs: 999 });

  expect(identity.users.get("user-a")?.createdAtMs).toBe(100);
});

test("同じユーザーの別端末は別の行になる", async () => {
  const identity = new InMemoryIdentityRepository();

  await identity.ensureUserAndDevice({ userId: "user-a", clientId: "client-1", nowMs: 100 });
  await identity.ensureUserAndDevice({ userId: "user-a", clientId: "client-2", nowMs: 100 });

  expect(identity.users.size).toBe(1);
  expect(identity.deviceCount).toBe(2);
});

test("IDに区切り文字を含んでも別の端末として扱う", () => {
  // 連結キーだと (userId="a:b", clientId="c") と (userId="a", clientId="b:c") が
  // 同じ値になり、後から同期した端末が主キー制約で弾かれる。
  const identity = new InMemoryIdentityRepository();

  return Promise.all([
    identity.ensureUserAndDevice({ userId: "a:b", clientId: "c", nowMs: 100 }),
    identity.ensureUserAndDevice({ userId: "a", clientId: "b:c", nowMs: 100 }),
  ]).then(() => {
    expect(identity.deviceCount).toBe(2);
    expect(identity.getDevice("a:b", "c")).toBeDefined();
    expect(identity.getDevice("a", "b:c")).toBeDefined();
  });
});

test("退会でユーザー、端末、学習イベントを削除し、同期の再作成を拒否する", async () => {
  const store = createInMemoryRepositoryStore();
  const identity = new InMemoryIdentityRepository(store);
  const events = new InMemoryLearningEventRepository(store);

  await identity.ensureUserAndDevice({ userId: "user-a", clientId: "client-1", nowMs: 100 });
  await events.append("user-a", [input("e1", "2026-09-05T00:00:01.000Z")]);
  await identity.startUserDeletion("user-a", 200);
  await identity.deleteUser("user-a");

  expect(identity.users.has("user-a")).toBe(false);
  expect(identity.deviceCount).toBe(0);
  expect(await events.countByUser("user-a")).toBe(0);
  await expect(
    identity.ensureUserAndDevice({ userId: "user-a", clientId: "client-1", nowMs: 300 }),
  ).rejects.toThrow("user deletion is in progress");
});
