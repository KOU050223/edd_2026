import { beforeEach, expect, test } from "vitest";
import { Hono } from "hono";
import type { Conversation } from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import { stubAuth } from "../auth/test-auth.js";
import {
  createInMemoryRepositoryStore,
  InMemoryAuditLogRepository,
  InMemoryConversationRepository,
  InMemoryIdentityRepository,
  type InMemoryRepositoryStore,
} from "../repository/memory.js";
import { InMemoryUserSettingsRepository } from "../repository/user-settings.js";
import type { ListConversationsResponse } from "../contract/conversations.js";
import { createConversationsRoute } from "./conversations.js";

let store: InMemoryRepositoryStore;
let identity: InMemoryIdentityRepository;
let conversations: InMemoryConversationRepository;
let settings: InMemoryUserSettingsRepository;
let app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;

/** 認証は `stubAuth` が担うので、env に資格情報は要らない。 */
const ENV = {} as unknown as CloudflareBindings;
const TOKENS = { "token-a": "user-a", "token-b": "user-b" };
const NOW = "2026-09-23T00:00:00.000Z";

beforeEach(() => {
  store = createInMemoryRepositoryStore();
  identity = new InMemoryIdentityRepository(store);
  conversations = new InMemoryConversationRepository(store);
  settings = new InMemoryUserSettingsRepository();
  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth(TOKENS));
  app.route(
    "/v1",
    createConversationsRoute(() => ({
      identity,
      conversations,
      settings,
      audit: new InMemoryAuditLogRepository(store),
      nowIso: () => NOW,
      nowMs: () => 1_000,
    })),
  );
});

function conversation(partial: Partial<Conversation> & { id: string }): Conversation {
  return {
    origin: "desktop",
    occurredAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:01.000Z",
    complete: true,
    messages: [
      { role: "context", text: "const x = 1", at: "2026-09-05T00:00:00.000Z" },
      { role: "user", text: "これは何？", at: "2026-09-05T00:00:00.000Z" },
      { role: "assistant", text: "変数の宣言です", at: "2026-09-05T00:00:01.000Z" },
    ],
    ...partial,
  };
}

/** オプトインを有効にした状態にする。実際の保存経路（put）を通す。 */
async function optIn(userId = "user-a") {
  await settings.put(
    userId,
    { displayName: null, activityPeriodDays: 30, saveConversationHistory: true },
    NOW,
  );
}

function put(token: string, body: unknown, id?: string) {
  const target = id ?? (body as { id?: string })?.id ?? "x";
  return app.request(
    `/v1/conversations/${encodeURIComponent(target)}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    ENV,
  );
}

function request(path: string, token: string, method = "GET") {
  return app.request(path, { method, headers: { Authorization: `Bearer ${token}` } }, ENV);
}

test("オプトインが無効なら本文を保存せず 403 を返す", async () => {
  // サーバー側のゲート。クライアント側のキャッシュが古くても、
  // オプトイン無しの本文は保存されない（docs/conversation-history.md）。
  const res = await put("token-a", conversation({ id: "c1" }));

  expect(res.status).toBe(403);
  // 応答の JSON 化は本番 app の onError が担う。ここでは種別だけを確かめる。
  await expect(res.text()).resolves.toBe("conversation_history_disabled");
  expect(await conversations.listAllByUser("user-a")).toEqual([]);
});

test("設定を一度も保存していない利用者も既定の無効として拒否する", async () => {
  // user_settings の行が無い状態は「オプトイン無し」と同じ意味である。
  expect(await settings.get("user-a")).toBeNull();

  const res = await put("token-a", conversation({ id: "c1" }));

  expect(res.status).toBe(403);
});

test("オプトイン済みなら会話を保存し、詳細で本文を読める", async () => {
  await optIn();
  const mine = conversation({ id: "c1", title: "変数とは" });

  const res = await put("token-a", mine);

  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toEqual({ saved: true });
  const detail = await request("/v1/conversations/c1", "token-a");
  expect(detail.status).toBe(200);
  expect(detail.headers.get("cache-control")).toBe("no-store");
  await expect(detail.json()).resolves.toEqual(mine);
});

test("同じ ID への再送は会話を更新する", async () => {
  // upsert。途中まで保存された会話へ後から完成形を送れる。
  await optIn();
  await put("token-a", conversation({ id: "c1", complete: false }));
  const res = await put(
    "token-a",
    conversation({
      id: "c1",
      updatedAt: "2026-09-05T00:00:05.000Z",
      complete: true,
    }),
  );

  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toEqual({ saved: true });
  const stored = await conversations.getById("user-a", "c1");
  expect(stored?.complete).toBe(true);
});

test("既存より古い会話は書き換えず newer_exists を返す", async () => {
  // 遅延した再送や古いスナップショットで新しい履歴が巻き戻るのを防ぐ。
  await optIn();
  await put("token-a", conversation({ id: "c1", updatedAt: "2026-09-05T00:00:10.000Z" }));

  const res = await put("token-a", conversation({ id: "c1", title: "古い" }));

  await expect(res.json()).resolves.toEqual({ saved: false, reason: "newer_exists" });
  expect((await conversations.getById("user-a", "c1"))?.title).toBeUndefined();
});

test("パスと本文の ID が一致しないリクエストは 400", async () => {
  await optIn();
  const res = await put("token-a", conversation({ id: "c1" }), "other");

  expect(res.status).toBe(400);
  expect(await conversations.listAllByUser("user-a")).toEqual([]);
});

test("契約外の入力は保存せず拒否する", async () => {
  await optIn();
  const cases: unknown[] = [
    // strictObject: 未知のキーを黙って剥がさない
    { ...conversation({ id: "c1" }), question: "本文が混ざった別名の項目" },
    // 許可リスト外の origin
    conversation({ id: "c1", origin: "unknown-app" as never }),
    // ISO として解釈できない時刻は一覧の並び順を壊す
    conversation({ id: "c1", occurredAt: "昨日" }),
    // 本文の役割ごとの上限
    conversation({
      id: "c1",
      messages: [{ role: "user", text: "あ".repeat(4_001), at: "2026-09-05T00:00:00.000Z" }],
    }),
    conversation({
      id: "c1",
      messages: [{ role: "context", text: "x".repeat(20_001), at: "2026-09-05T00:00:00.000Z" }],
    }),
    // メッセージ0件の会話は履歴として意味を持たない
    conversation({ id: "c1", messages: [] }),
    // メッセージの時刻も ISO を要求する
    conversation({
      id: "c1",
      messages: [{ role: "user", text: "?", at: "not-a-date" }],
    }),
  ];
  for (const body of cases) {
    const res = await put("token-a", body);
    expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
  }
  expect(await conversations.listAllByUser("user-a")).toEqual([]);
});

test("本文が JSON でなければ 400 を返す", async () => {
  await optIn();
  const res = await app.request(
    "/v1/conversations/c1",
    {
      method: "PUT",
      headers: { Authorization: "Bearer token-a", "Content-Type": "application/json" },
      body: "not-json",
    },
    ENV,
  );
  expect(res.status).toBe(400);
});

test("一覧は本文を含まず、更新時刻の降順で返す", async () => {
  await optIn();
  await put("token-a", conversation({ id: "old", updatedAt: "2026-09-05T00:00:01.000Z" }));
  await put("token-a", conversation({ id: "new", updatedAt: "2026-09-06T00:00:00.000Z" }));

  const res = await request("/v1/conversations", "token-a");

  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = (await res.json()) as ListConversationsResponse;
  expect(body.conversations.map((c) => c.id)).toEqual(["new", "old"]);
  expect(body.nextCursor).toBeNull();
  const summary = body.conversations[0]!;
  expect(summary).toEqual({
    id: "new",
    origin: "desktop",
    occurredAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    messageCount: 3,
    complete: true,
  });
  // 一覧が本文を返さないこと。サイドバー向けの軽い形である。
  expect("messages" in summary).toBe(false);
});

test("一覧はカーソルでページングする", async () => {
  await optIn();
  for (let i = 0; i < 5; i++) {
    await put("token-a", conversation({ id: `c${i}`, updatedAt: `2026-09-05T00:00:0${i}.000Z` }));
  }

  const first = (await (
    await request("/v1/conversations?limit=2", "token-a")
  ).json()) as ListConversationsResponse;
  expect(first.conversations.map((c) => c.id)).toEqual(["c4", "c3"]);
  expect(first.nextCursor).not.toBeNull();

  const second = (await (
    await request(`/v1/conversations?limit=2&cursor=${first.nextCursor}`, "token-a")
  ).json()) as ListConversationsResponse;
  expect(second.conversations.map((c) => c.id)).toEqual(["c2", "c1"]);

  const third = (await (
    await request(`/v1/conversations?limit=2&cursor=${second.nextCursor}`, "token-a")
  ).json()) as ListConversationsResponse;
  expect(third.conversations.map((c) => c.id)).toEqual(["c0"]);
  expect(third.nextCursor).toBeNull();
});

test("一覧は同時刻の会話を ID の昇順で安定させる", async () => {
  await optIn();
  await put("token-a", conversation({ id: "b" }));
  await put("token-a", conversation({ id: "a" }));

  const body = (await (
    await request("/v1/conversations", "token-a")
  ).json()) as ListConversationsResponse;
  expect(body.conversations.map((c) => c.id)).toEqual(["a", "b"]);
});

test.each([
  ["limit=0", "limit が下限未満"],
  ["limit=101", "limit が上限超過"],
  ["limit=abc", "limit が数値でない"],
  ["cursor=not-a-cursor", "解釈できないカーソル"],
])("一覧の不正なクエリ（%s）は先頭へ丸めず 400 にする", async (query) => {
  await optIn();
  await put("token-a", conversation({ id: "c1" }));

  const res = await request(`/v1/conversations?${query}`, "token-a");

  expect(res.status).toBe(400);
});

test("存在しない会話の詳細は 404", async () => {
  const res = await request("/v1/conversations/none", "token-a");
  expect(res.status).toBe(404);
});

test("1件削除は対象だけを消し、再実行しても失敗しない", async () => {
  await optIn();
  await put("token-a", conversation({ id: "c1" }));
  await put("token-a", conversation({ id: "c2" }));

  const res = await request("/v1/conversations/c1", "token-a", "DELETE");

  await expect(res.json()).resolves.toEqual({ deletedCount: 1 });
  expect((await conversations.listAllByUser("user-a")).map((c) => c.id)).toEqual(["c2"]);

  const again = await request("/v1/conversations/c1", "token-a", "DELETE");
  await expect(again.json()).resolves.toEqual({ deletedCount: 0 });
});

test("全件削除は件数を返し監査ログへ残す", async () => {
  await optIn();
  await put("token-a", conversation({ id: "c1" }));
  await put("token-a", conversation({ id: "c2" }));

  const res = await request("/v1/conversations", "token-a", "DELETE");

  await expect(res.json()).resolves.toEqual({ deletedCount: 2 });
  expect(await conversations.listAllByUser("user-a")).toEqual([]);
  expect(store.auditLog).toEqual([
    {
      userId: "user-a",
      action: "conversations.deleted",
      occurredAtMs: 1_000,
      detail: { deletedCount: 2 },
    },
  ]);
});

test("エクスポートは本文込みの全会話を返し監査ログへ残す", async () => {
  await optIn();
  const mine = conversation({ id: "c1" });
  await put("token-a", mine);

  const res = await request("/v1/conversations:export", "token-a");

  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  await expect(res.json()).resolves.toEqual({
    version: 1,
    exportedAt: NOW,
    conversations: [mine],
  });
  expect(store.auditLog).toEqual([
    {
      userId: "user-a",
      action: "conversations.exported",
      occurredAtMs: 1_000,
      detail: { conversationCount: 1 },
    },
  ]);
});

test("他人の会話は一覧・詳細・削除のいずれでも見えない", async () => {
  // 会話 ID はユーザー単位でしか一意にならないため、同じ ID を他人も使える。
  await optIn("user-b");
  await put("token-b", conversation({ id: "shared", title: "他人の会話" }));

  const list = (await (
    await request("/v1/conversations", "token-a")
  ).json()) as ListConversationsResponse;
  expect(list.conversations).toEqual([]);
  expect((await request("/v1/conversations/shared", "token-a")).status).toBe(404);

  const del = await request("/v1/conversations/shared", "token-a", "DELETE");
  await expect(del.json()).resolves.toEqual({ deletedCount: 0 });
  expect((await conversations.getById("user-b", "shared"))?.title).toBe("他人の会話");
});

test.each([
  ["PUT", "/v1/conversations/c1"],
  ["GET", "/v1/conversations"],
  ["GET", "/v1/conversations/c1"],
  ["GET", "/v1/conversations:export"],
  ["DELETE", "/v1/conversations/c1"],
  ["DELETE", "/v1/conversations"],
])("%s %s は認証が無ければ 401 を返し、何も書かず監査ログも残さない", async (method, path) => {
  const res = await app.request(
    path,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "PUT" ? JSON.stringify(conversation({ id: "c1" })) : undefined,
    },
    ENV,
  );

  expect(res.status).toBe(401);
  expect(await conversations.listAllByUser("user-a")).toEqual([]);
  expect(store.auditLog).toEqual([]);
});

test("オプトインを外すとそれ以降の書き込みは拒否される", async () => {
  // 無効にしても保存済みの履歴は残る。消すのは削除の経路であり、
  // オプトインを切る操作は今後の保存を止めるだけである。
  await optIn();
  await put("token-a", conversation({ id: "c1" }));
  await settings.put(
    "user-a",
    { displayName: null, activityPeriodDays: 30, saveConversationHistory: false },
    NOW,
  );

  const res = await put("token-a", conversation({ id: "c2" }));

  expect(res.status).toBe(403);
  expect((await conversations.listAllByUser("user-a")).map((c) => c.id)).toEqual(["c1"]);
});
