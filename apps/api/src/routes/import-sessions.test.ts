import { beforeEach, expect, test } from "vitest";
import { Hono } from "hono";
import type { LearningEvidence } from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import { stubAuth } from "../auth/test-auth.js";
import {
  createInMemoryRepositoryStore,
  InMemoryAuditLogRepository,
  InMemoryIdentityRepository,
  InMemoryImportSessionRepository,
  InMemoryLearningEvidenceRepository,
  type InMemoryRepositoryStore,
} from "../repository/memory.js";
import { createImportSessionsRoute } from "./import-sessions.js";
import type {
  CreateImportSessionResponse,
  ImportSessionDetail,
  UndoImportSessionResponse,
} from "../contract/history-import.js";

let store: InMemoryRepositoryStore;
let identity: InMemoryIdentityRepository;
let sessions: InMemoryImportSessionRepository;
let evidence: InMemoryLearningEvidenceRepository;
let app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;

/** 認証は `stubAuth` が担うので、env に資格情報は要らない。 */
const ENV = {} as unknown as CloudflareBindings;
const NOW = "2026-10-01T00:00:00.000Z";
const TOKENS = { "token-a": "user-a", "token-b": "user-b" };

beforeEach(() => {
  store = createInMemoryRepositoryStore();
  identity = new InMemoryIdentityRepository(store);
  sessions = new InMemoryImportSessionRepository(store);
  evidence = new InMemoryLearningEvidenceRepository(store);
  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth(TOKENS));
  app.route(
    "/v1",
    createImportSessionsRoute(() => ({
      identity,
      sessions,
      evidence,
      audit: new InMemoryAuditLogRepository(store),
      nowIso: () => NOW,
      nowMs: () => 1_000,
    })),
  );
});

function evidenceItem(partial: Partial<LearningEvidence> & { id: string }): LearningEvidence {
  return {
    conceptIds: ["go.defer"],
    source: { provider: "codex", importedBy: "desktop" },
    kind: "question",
    confidence: 0.8,
    importSessionId: "import-1",
    ...partial,
  };
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "import-1",
    importedBy: "desktop",
    providers: ["codex"],
    conversationCount: 3,
    ignoredCount: 1,
    evidence: [evidenceItem({ id: "import-1:codex:s1" })],
    ...overrides,
  };
}

function post(path: string, token: string, body: unknown) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    ENV,
  );
}

function get(path: string, token: string) {
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } }, ENV);
}

function del(path: string, token: string) {
  return app.request(
    path,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    ENV,
  );
}

test("Import Session と Evidence を保存し、応答へ集計を載せる", async () => {
  const res = await post("/v1/import-sessions", "token-a", createBody());

  expect(res.status).toBe(200);
  const body = (await res.json()) as CreateImportSessionResponse;
  expect(body).toMatchObject({
    id: "import-1",
    status: "applied",
    importedBy: "desktop",
    providers: ["codex"],
    conversationCount: 3,
    evidenceCount: 1,
    conceptCount: 1,
    alreadyExisted: false,
  });
  expect(await evidence.listByUser("user-a")).toHaveLength(1);
});

test("同じ ID の再送は重複して保存しない", async () => {
  await post("/v1/import-sessions", "token-a", createBody());

  const res = await post("/v1/import-sessions", "token-a", createBody());

  expect(res.status).toBe(200);
  expect(((await res.json()) as CreateImportSessionResponse).alreadyExisted).toBe(true);
  expect(await evidence.listByUser("user-a")).toHaveLength(1);
});

test("Session ID と食い違う importSessionId を持つ Evidence は拒否する", async () => {
  const res = await post(
    "/v1/import-sessions",
    "token-a",
    createBody({
      evidence: [evidenceItem({ id: "import-1:codex:e1", importSessionId: "other-session" })],
    }),
  );

  // Undo の単位が壊れる組み合わせを保存しない。
  expect(res.status).toBe(400);
  expect(await sessions.listByUser("user-a")).toEqual([]);
});

test("providers に無いソースの Evidence は拒否する", async () => {
  const res = await post(
    "/v1/import-sessions",
    "token-a",
    createBody({
      evidence: [
        evidenceItem({
          id: "import-1:copilot:s1",
          source: { provider: "copilot", importedBy: "desktop" },
        }),
      ],
    }),
  );

  expect(res.status).toBe(400);
  expect(await sessions.listByUser("user-a")).toEqual([]);
});

test.each<[string, Record<string, unknown>]>([
  ["conceptIds が空", { conceptIds: [] }],
  ["confidence が範囲外", { confidence: 1.5 }],
  ["confidence が NaN", { confidence: Number.NaN }],
  ["observedAt が解釈不能", { observedAt: "去年くらい" }],
  ["未知の kind", { kind: "browsing" }],
])("不正な Evidence（%s）を含む Import は 400 になり何も保存しない", async (_label, patch) => {
  const res = await post(
    "/v1/import-sessions",
    "token-a",
    createBody({
      // 不正な値をわざと流すため、ここでは型を通さない。
      // ID は `${sessionId}:${provider}:${sourceId}` の契約を満たす必要がある。
      evidence: [
        evidenceItem({ id: "import-1:codex:e1", ...patch } as Partial<LearningEvidence> & {
          id: string;
        }),
      ],
    }),
  );

  expect(res.status).toBe(400);
  expect(await sessions.listByUser("user-a")).toEqual([]);
  expect(await evidence.listByUser("user-a")).toEqual([]);
});

test.each([
  ["Session ID と合わない", "other-session:codex:s1"],
  ["provider と合わない", "import-1:copilot:s1"],
  ["契約外の採番", "random-id"],
])("Evidence ID が %s 場合は 400 になり何も保存しない", async (_label, id) => {
  const res = await post(
    "/v1/import-sessions",
    "token-a",
    createBody({
      evidence: [evidenceItem({ id })],
    }),
  );

  expect(res.status).toBe(400);
  expect(await sessions.listByUser("user-a")).toEqual([]);
  expect(await evidence.listByUser("user-a")).toEqual([]);
});

test("未知のキーを持つリクエストは拒否する", async () => {
  // 会話本文を置く場所は無い。剥がして受理すると送信側が
  // 「保存された」と誤解する（learning-event.ts と同じ方針）。
  const res = await post(
    "/v1/import-sessions",
    "token-a",
    createBody({ conversationBodies: ["秘密のコード"] }),
  );

  expect(res.status).toBe(400);
  expect(await sessions.listByUser("user-a")).toEqual([]);
});

test("一覧は自分の Session だけを新しい順に返す", async () => {
  await post("/v1/import-sessions", "token-a", createBody());
  await post("/v1/import-sessions", "token-b", createBody({ id: "import-b" }));

  const res = await get("/v1/import-sessions", "token-a");

  expect(res.status).toBe(200);
  const body = (await res.json()) as { sessions: { id: string }[] };
  expect(body.sessions.map((s) => s.id)).toEqual(["import-1"]);
});

test("詳細は Evidence と unmapped 候補を含む", async () => {
  await post(
    "/v1/import-sessions",
    "token-a",
    createBody({ unmappedCandidates: [{ sourceId: "s9", candidate: "kubernetes" }] }),
  );

  const res = await get("/v1/import-sessions/import-1", "token-a");

  expect(res.status).toBe(200);
  const detail = (await res.json()) as ImportSessionDetail;
  expect(detail.evidence).toHaveLength(1);
  expect(detail.unmappedCandidates).toEqual([{ sourceId: "s9", candidate: "kubernetes" }]);
});

test("他人の Session の詳細は 404", async () => {
  await post("/v1/import-sessions", "token-a", createBody());

  expect((await get("/v1/import-sessions/import-1", "token-b")).status).toBe(404);
});

test("Undo は Evidence を消して Session を undone にする", async () => {
  await post("/v1/import-sessions", "token-a", createBody());

  const res = await del("/v1/import-sessions/import-1", "token-a");

  expect(res.status).toBe(200);
  expect((await res.json()) as UndoImportSessionResponse).toEqual({
    id: "import-1",
    status: "undone",
    deletedEvidenceCount: 1,
  });
  expect(await evidence.listByUser("user-a")).toEqual([]);
  const detail = (await (
    await get("/v1/import-sessions/import-1", "token-a")
  ).json()) as ImportSessionDetail;
  expect(detail.status).toBe("undone");
});

test("Undo 済みの Session を同じ ID で再送しても Evidence は復活しない", async () => {
  await post("/v1/import-sessions", "token-a", createBody());
  await del("/v1/import-sessions/import-1", "token-a");

  const res = await post("/v1/import-sessions", "token-a", createBody());

  expect(res.status).toBe(200);
  expect(await evidence.listByUser("user-a")).toEqual([]);
  const detail = (await (
    await get("/v1/import-sessions/import-1", "token-a")
  ).json()) as ImportSessionDetail;
  expect(detail.status).toBe("undone");
});

test("Undo の再実行は失敗にしない", async () => {
  await post("/v1/import-sessions", "token-a", createBody());
  await del("/v1/import-sessions/import-1", "token-a");

  const res = await del("/v1/import-sessions/import-1", "token-a");

  expect(res.status).toBe(200);
  expect((await res.json()) as UndoImportSessionResponse).toEqual({
    id: "import-1",
    status: "undone",
    deletedEvidenceCount: 0,
  });
});

test("存在しない Session の Undo は 404", async () => {
  expect((await del("/v1/import-sessions/none", "token-a")).status).toBe(404);
});

test("Undo は監査ログに記録される", async () => {
  await post("/v1/import-sessions", "token-a", createBody());

  await del("/v1/import-sessions/import-1", "token-a");

  expect(store.auditLog).toEqual([
    {
      userId: "user-a",
      action: "learning_evidence.deleted",
      occurredAtMs: 1_000,
      detail: { sessionId: "import-1", deletedCount: 1 },
    },
  ]);
});

test("Evidence の一覧は自分の分だけを返す", async () => {
  await post("/v1/import-sessions", "token-a", createBody());
  await post("/v1/import-sessions", "token-b", createBody({ id: "import-b" }));

  const res = await get("/v1/learning-evidence", "token-a");

  expect(res.status).toBe(200);
  const body = (await res.json()) as { evidence: LearningEvidence[] };
  expect(body.evidence.map((e) => e.id)).toEqual(["import-1:codex:s1"]);
});

test("エクスポートは Session と Evidence を返し、監査ログに記録される", async () => {
  await post("/v1/import-sessions", "token-a", createBody());

  const res = await get("/v1/learning-evidence:export", "token-a");

  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = (await res.json()) as { sessions: unknown[]; evidence: unknown[] };
  expect(body.sessions).toHaveLength(1);
  expect(body.evidence).toHaveLength(1);
  expect(store.auditLog).toEqual([
    {
      userId: "user-a",
      action: "learning_evidence.exported",
      occurredAtMs: 1_000,
      detail: { sessionCount: 1, evidenceCount: 1 },
    },
  ]);
});

test("ソース単位の削除はそのソースの Evidence だけを消す", async () => {
  await post(
    "/v1/import-sessions",
    "token-a",
    createBody({
      providers: ["codex", "copilot"],
      evidence: [
        evidenceItem({ id: "import-1:codex:s1" }),
        evidenceItem({
          id: "import-1:copilot:s2",
          source: { provider: "copilot", importedBy: "desktop" },
        }),
      ],
    }),
  );

  const res = await del("/v1/learning-evidence?provider=codex", "token-a");

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ deletedCount: 1, sessionsMarkedUndone: 0 });
  // copilot の Evidence は残り、Session は applied のまま。
  expect((await evidence.listByUser("user-a")).map((e) => e.id)).toEqual(["import-1:copilot:s2"]);
  const detail = (await (
    await get("/v1/import-sessions/import-1", "token-a")
  ).json()) as ImportSessionDetail;
  expect(detail.status).toBe("applied");
});

test("ソースの削除で Evidence が残らなかった Session は undone に倒れる", async () => {
  await post("/v1/import-sessions", "token-a", createBody());

  await del("/v1/learning-evidence?provider=codex", "token-a");

  const detail = (await (
    await get("/v1/import-sessions/import-1", "token-a")
  ).json()) as ImportSessionDetail;
  expect(detail.status).toBe("undone");
});

test.each([
  ["provider が無い", "/v1/learning-evidence"],
  ["provider が未知", "/v1/learning-evidence?provider=emacs"],
])("ソース削除の query が不正（%s）なら 400 で何も消さない", async (_label, path) => {
  await post("/v1/import-sessions", "token-a", createBody());

  const res = await del(path, "token-a");

  expect(res.status).toBe(400);
  expect(await evidence.listByUser("user-a")).toHaveLength(1);
});

test.each([
  ["POST", "/v1/import-sessions"],
  ["GET", "/v1/import-sessions"],
  ["GET", "/v1/import-sessions/x"],
  ["DELETE", "/v1/import-sessions/x"],
  ["GET", "/v1/learning-evidence"],
  ["GET", "/v1/learning-evidence:export"],
  ["DELETE", "/v1/learning-evidence?provider=codex"],
])("%s %s は認証が無ければ 401", async (method, path) => {
  const res = await app.request(
    path,
    { method, headers: { "Content-Type": "application/json" } },
    ENV,
  );

  expect(res.status).toBe(401);
});
