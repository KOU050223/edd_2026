import { beforeEach, expect, test } from "vitest";
import { Hono } from "hono";
import type { LearningEvent } from "@gakushu-sochi/domain";
import { type AuthVariables } from "../auth/middleware.js";
import { TEST_TOKEN, stubAuth } from "../auth/test-auth.js";
import {
  InMemoryImportSessionRepository,
  InMemoryLearningEventRepository,
  InMemoryLearningEvidenceRepository,
  createInMemoryRepositoryStore,
  type InMemoryRepositoryStore,
} from "../repository/memory.js";
import { createLearningProfileRoute } from "./learning-profile.js";
import type { LearningProfileResponse } from "../contract/learning-profile.js";

let store: InMemoryRepositoryStore;
let events: InMemoryLearningEventRepository;
let evidence: InMemoryLearningEvidenceRepository;
let sessions: InMemoryImportSessionRepository;
let app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;

/** 認証は `stubAuth` が担うので、env に資格情報は要らない。 */
const ENV = {};
const NOW = "2026-09-06T00:00:00.000Z";

beforeEach(() => {
  store = createInMemoryRepositoryStore();
  events = new InMemoryLearningEventRepository(store);
  evidence = new InMemoryLearningEvidenceRepository(store);
  sessions = new InMemoryImportSessionRepository(store);
  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth("user-a"));
  app.route(
    "/v1",
    createLearningProfileRoute(() => ({ events, evidence, nowIso: () => NOW })),
  );
});

async function seed(userId: string, list: Partial<LearningEvent>[]) {
  await events.append(
    userId,
    list.map((partial, i) => ({
      event: {
        id: partial.id ?? `e${i}`,
        occurredAt: partial.occurredAt ?? `2026-09-05T00:00:0${i}.000Z`,
        type: partial.type ?? "solved_independently",
        origin: "vscode",
        conceptIds: partial.conceptIds ?? ["go.defer"],
      },
      clientId: "client-1",
      receivedAtMs: 0,
    })),
  );
}

async function getProfile(token = TEST_TOKEN) {
  return app.request(
    "/v1/learning-profile",
    { headers: { Authorization: `Bearer ${token}` } },
    ENV as unknown as CloudflareBindings,
  );
}

test("イベントが無ければ空のプロファイルを返す", async () => {
  const res = await getProfile();

  expect(res.status).toBe(200);
  const body = (await res.json()) as LearningProfileResponse;
  expect(body.concepts).toEqual([]);
  expect(body.eventCount).toBe(0);
  expect(body.derivedAt).toBe(NOW);
});

test("観測のあるConceptだけを返し、既知のConceptを0で埋めない", async () => {
  // unobserved は「習熟度が低い」ではなく「判断材料がない」。
  // 全件を0で返すとクライアントが両者を区別できない。
  await seed("user-a", [{ conceptIds: ["go.defer"] }]);

  const body = (await (await getProfile()).json()) as LearningProfileResponse;

  expect(body.concepts).toHaveLength(1);
  expect(body.concepts[0]?.conceptId).toBe("go.defer");
});

test("習熟度をログから導出する", async () => {
  await seed("user-a", [
    { id: "e1", type: "solved_independently" },
    { id: "e2", type: "solved_independently" },
  ]);

  const body = (await (await getProfile()).json()) as LearningProfileResponse;

  expect(body.concepts[0]?.status).toBe("confirmed");
  expect(body.concepts[0]?.evidence.solvedIndependentlyCount).toBe(2);
});

test("イベントの生ログは返さない", async () => {
  await seed("user-a", [{ id: "e1" }]);

  const body = (await (await getProfile()).json()) as LearningProfileResponse;

  // 導出済みの読み取りモデルだけを返す（docs/architecture.md）。
  expect(body).not.toHaveProperty("events");
  expect(body.eventCount).toBe(1);
});

test("表示名を添えて返す", async () => {
  await seed("user-a", [{ conceptIds: ["go.defer"] }]);

  const body = (await (await getProfile()).json()) as LearningProfileResponse;

  expect(body.concepts[0]?.label).toBeTypeOf("string");
});

test("Concept一覧に無いIDでも落とさず返す", async () => {
  // 一覧から Concept を消しても、過去のイベントは残る。
  await seed("user-a", [{ conceptIds: ["go.unknown_concept"] }]);

  const body = (await (await getProfile()).json()) as LearningProfileResponse;

  expect(body.concepts[0]?.conceptId).toBe("go.unknown_concept");
  expect(body.concepts[0]?.label).toBeUndefined();
});

test("他のユーザーのイベントは含めない", async () => {
  await seed("user-b", [{ id: "other-1" }, { id: "other-2" }]);

  const body = (await (await getProfile()).json()) as LearningProfileResponse;

  expect(body.eventCount).toBe(0);
  expect(body.concepts).toEqual([]);
});

test("発生順と到着順が食い違っても発生時刻順で導出する", async () => {
  // オフラインキューが後から古いイベントを届けた状況。
  await seed("user-a", [
    { id: "late", occurredAt: "2026-09-05T00:00:03.000Z", type: "error_recurred" },
  ]);
  await seed("user-a", [
    { id: "early", occurredAt: "2026-09-05T00:00:01.000Z", type: "solved_independently" },
  ]);

  const body = (await (await getProfile()).json()) as LearningProfileResponse;

  expect(body.concepts[0]?.evidence.recentTypes).toEqual([
    "solved_independently",
    "error_recurred",
  ]);
});

test("認証が無ければ401にする", async () => {
  expect((await getProfile("wrong")).status).toBe(401);
});

test("外部履歴由来の Familiarity を concepts とは別に返す", async () => {
  // Mastery と Familiarity を混ぜない（Issue #157）。
  // 「過去に触れた」と「現在理解している」は別の情報である。
  await sessions.createWithEvidence(
    "user-a",
    {
      id: "import-1",
      importedBy: "desktop",
      providers: ["codex"],
      conversationCount: 3,
      ignoredCount: 0,
      unmappedCandidates: [],
      evidenceCount: 1,
      conceptCount: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
    [
      {
        id: "import-1:codex:s1",
        conceptIds: ["go.defer"],
        source: { provider: "codex", importedBy: "desktop" },
        kind: "question",
        observedAt: "2025-01-01T00:00:00.000Z",
        confidence: 0.8,
        importSessionId: "import-1",
      },
    ],
  );

  const body = (await (await getProfile()).json()) as LearningProfileResponse;

  // 学習イベントが無いので concepts（Mastery 由来）は空のまま。
  expect(body.concepts).toEqual([]);
  // Familiarity には「Codex で1件触れた」という根拠が載る。
  expect(body.familiarity).toEqual([
    {
      conceptId: "go.defer",
      observationCount: 1,
      maxConfidence: 0.8,
      lastObservedAt: "2025-01-01T00:00:00.000Z",
      sources: [{ provider: "codex", count: 1, lastObservedAt: "2025-01-01T00:00:00.000Z" }],
      label: body.familiarity[0]?.label,
    },
  ]);
  expect(body.familiarity[0]?.label).toBeTypeOf("string");
});
