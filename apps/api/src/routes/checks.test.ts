import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  CHECK_GENERATION_CONSENT_VERSION,
  type LearningEvent,
  type LearningObjective,
} from "@gakushu-sochi/domain";
import { createAuth, type AuthVariables } from "../auth/middleware.js";
import type { AuthVerifier } from "../auth/verifier.js";
import { AI_USAGE_LIMITS } from "../contract/ai-usage.js";
import { InMemoryAiUsageRepository } from "../repository/ai-usage.js";
import { InMemoryUserSettingsRepository } from "../repository/user-settings.js";
import {
  createInMemoryRepositoryStore,
  InMemoryAuditLogRepository,
  InMemoryCheckGenerationConsentRepository,
  InMemoryConversationRepository,
  InMemoryIdentityRepository,
  InMemoryLearningEventRepository,
  InMemoryLearningEvidenceRepository,
  InMemoryPersonalCheckRepository,
  type InMemoryRepositoryStore,
  InMemoryLearningMapRepository,
} from "../repository/memory.js";
import { InMemoryMasteryOverrideRepository } from "../repository/mastery-overrides.js";
import { createAiRoute } from "./ai.js";
import { createChecksRoute, parseModelList } from "./checks.js";
import {
  seedTestMap,
  TEST_MAP_ID,
  TEST_MAP_BASE,
  TEST_MAP_NODE,
  TEST_MAP_OBJECTIVES,
  TEST_MAP_TITLE,
} from "../maps/test-map.js";
import { InMemoryUserPlanRepository } from "../repository/user-plans.js";

describe("parseModelList", () => {
  it("カンマ区切りを並びにし、空白と空の要素を捨てる", () => {
    expect(parseModelList(" gemini-3.8-flash, ,gemini-3.5-flash-lite ")).toEqual([
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
    ]);
    expect(parseModelList("")).toEqual([]);
    expect(parseModelList(undefined)).toEqual([]);
  });
});

const CONCEPT_ID = "go.pointer_receiver";
const NOW = new Date("2026-09-26T09:00:00.000Z");
const USER_A = "auth0|user-a";

const PASSING_LIMITER = {
  limit: () => Promise.resolve({ success: true }),
} as unknown as RateLimit;

const BLOCKING_LIMITER = {
  limit: () => Promise.resolve({ success: false }),
} as unknown as RateLimit;

/**
 * 認証を通ったものとして、トークンごとに固定の sub を返す検証器（`ai.test.ts` と同じ継ぎ目）。
 * 問題と材料が利用者をまたがないことを見るため、2人分を持つ。
 */
const VERIFIER: AuthVerifier = {
  verify: (token) => {
    if (token === "valid-token") return Promise.resolve({ sub: USER_A });
    if (token === "other-token") return Promise.resolve({ sub: "auth0|user-b" });
    return Promise.reject(new Error("unexpected token in test"));
  },
};

const OBJECTIVE_ID = `${CONCEPT_ID}:copy`;
const OBJECTIVES: LearningObjective[] = [
  { id: OBJECTIVE_ID, conceptId: CONCEPT_ID, label: "値レシーバには複製が渡る" },
  { id: `${CONCEPT_ID}:choose`, conceptId: CONCEPT_ID, label: "レシーバの選び方" },
];

interface Harness {
  app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;
  store: InMemoryRepositoryStore;
  checks: InMemoryPersonalCheckRepository;
  consents: InMemoryCheckGenerationConsentRepository;
  events: InMemoryLearningEventRepository;
  conversations: InMemoryConversationRepository;
  settings: InMemoryUserSettingsRepository;
  maps: InMemoryLearningMapRepository;
  plans: InMemoryUserPlanRepository;
}

/**
 * `app.ts` と同じ組み立てを、生成ルートの分だけ作る。
 *
 * AI ルートも同じ `AiUsageRepository` へ載せる。生成が回数を消費したことを、
 * 利用者向けの読み取り（`GET /v1/ai/usage`）から確かめられるようにするため。
 */
function buildApp(
  objectives: readonly LearningObjective[] = [],
  options: { enforceUsageLimits?: boolean; models?: readonly string[] } = {},
): Harness {
  const store = createInMemoryRepositoryStore();
  store.fixedObjectives.splice(
    0,
    store.fixedObjectives.length,
    ...objectives.map((objective) => ({ ...objective, source: "manual" as const })),
  );
  const usage = new InMemoryAiUsageRepository();
  const plans = new InMemoryUserPlanRepository();
  const identity = new InMemoryIdentityRepository(store);
  const checks = new InMemoryPersonalCheckRepository(store);
  const consents = new InMemoryCheckGenerationConsentRepository(store);
  const events = new InMemoryLearningEventRepository(store);
  const conversations = new InMemoryConversationRepository(store);
  const settings = new InMemoryUserSettingsRepository();
  const maps = new InMemoryLearningMapRepository(store);
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use(
    "/v1/*",
    createAuth(() => VERIFIER),
  );
  app.route(
    "/v1",
    createChecksRoute((env) => ({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      fetch: (input, init) => globalThis.fetch(input, init),
      retryDelaysMs: [0, 0],
      checks,
      consents,
      events,
      conversations,
      settings,
      usage,
      plans,
      identity,
      audit: new InMemoryAuditLogRepository(store),
      maps,
      ...options,
      now: () => NOW,
    })),
  );
  app.route(
    "/v1",
    createAiRoute((env) => ({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      fetch: (input, init) => globalThis.fetch(input, init),
      usage,
      plans,
      identity,
      events,
      evidence: new InMemoryLearningEvidenceRepository(store),
      overrides: new InMemoryMasteryOverrideRepository(),
      maps,
      now: () => NOW,
    })),
  );
  return { app, store, checks, consents, events, conversations, settings, maps, plans };
}

const ENV = {
  GEMINI_API_KEY: "test-key",
  GEMINI_MODEL: "gemini-3.6-flash",
  PROFILE_RATE_LIMITER: PASSING_LIMITER,
} as unknown as CloudflareBindings;

function question(overrides: Record<string, unknown> = {}) {
  return {
    prompt: "値レシーバのメソッドで状態を変えたとき、呼び出し元の値はどうなるか。",
    choices: ["変わらない", "変わる", "コンパイルできない", "実行時に落ちる"],
    answerIndex: 0,
    explanation: "値レシーバには複製が渡るため、呼び出し元の値は変わらない。",
    ...overrides,
  };
}

function generatedCheck(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    conceptId: CONCEPT_ID,
    overview: question(),
    practice: question({ code: "func (c Counter) Add() { c.n++ }" }),
    ...overrides,
  });
}

/** 上流の `generateContent` の応答を差し替える。 */
function stubUpstream(text: string, totalTokenCount = 900) {
  const body = JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { totalTokenCount },
    modelVersion: "gemini-3.6-flash",
  });
  const fetchMock = vi
    .fn()
    .mockImplementation(
      () =>
        Promise.resolve(
          new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
        ) as Promise<Response>,
    );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** その場で同意した、Concept 単位・基礎の生成（項目を持たない Concept で使う）。 */
const CONCEPT_BASIC = {
  conceptId: CONCEPT_ID,
  scope: "concept",
  level: "basic",
  consentVersion: CHECK_GENERATION_CONSENT_VERSION,
};

const OBJECTIVE_BASIC = { ...CONCEPT_BASIC, scope: "objective", objectiveId: OBJECTIVE_ID };

function generate(
  harness: Harness,
  body: Record<string, unknown> = CONCEPT_BASIC,
  env: CloudflareBindings = ENV,
  token = "valid-token",
) {
  return harness.app.request(
    "https://api.example.test/v1/checks:generate",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

function call(
  harness: Harness,
  path: string,
  init: { method?: string; body?: string } = {},
  token = "valid-token",
) {
  return harness.app.request(
    `https://api.example.test/v1${path}`,
    {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    },
    ENV,
  );
}

async function usedToday(harness: Harness): Promise<number> {
  const usage = await call(harness, "/ai/usage");
  const body = (await usage.json()) as { managedAi: { daily: { used: number } } };
  return body.managedAi.daily.used;
}

/**
 * 本人が項目を自力解決した会話を、学習イベントと会話の両方に置く。
 * 「質問履歴の保存」も有効にする（会話が保存されるのは有効なときだけなので、実際の状態に揃える）。
 */
async function seedSolvedConversation(
  harness: Harness,
  conversationId: string,
  occurredAt: string,
  questionText: string,
) {
  await harness.settings.put(USER_A, { saveConversationHistory: true }, occurredAt);
  const event: LearningEvent = {
    id: `event-${conversationId}`,
    occurredAt,
    type: "solved_independently",
    origin: "vscode",
    conceptIds: [CONCEPT_ID],
    objectiveIds: [OBJECTIVE_ID],
    sessionId: conversationId,
  };
  await harness.events.append(USER_A, [
    { event, clientId: "vscode-1", receivedAtMs: Date.parse(occurredAt) },
  ]);
  await harness.conversations.upsert(
    USER_A,
    {
      id: conversationId,
      origin: "vscode",
      occurredAt,
      updatedAt: occurredAt,
      complete: true,
      messages: [
        { role: "context", text: "SELECTED-CODE-SECRET", at: occurredAt },
        { role: "user", text: questionText, at: occurredAt },
        { role: "assistant", text: "ASSISTANT-ANSWER", at: occurredAt },
      ],
    },
    Date.parse(occurredAt),
  );
}

/** 上流へ送ったプロンプトの本文。 */
function sentPrompt(fetchMock: ReturnType<typeof stubUpstream>): string {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  const body = JSON.parse(String(init.body)) as { contents: { parts: { text: string }[] }[] };
  return body.contents[0]!.parts[0]!.text;
}

/** 生成の記録は運用で追う材料なので、テスト中は黙らせた上で内容を確かめる。 */
function silenceInfo() {
  return vi.spyOn(console, "info").mockImplementation(() => undefined);
}

function silenceWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => undefined);
}

function silenceError() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /v1/checks:generate", () => {
  it("概要問題と実践問題の2問を、選んだ範囲とレベル付きで返して保存する", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    silenceInfo();
    const harness = buildApp();

    const response = await generate(harness);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const expected = {
      conceptId: CONCEPT_ID,
      overview: question(),
      practice: question({ code: "func (c Counter) Add() { c.n++ }" }),
      scope: "concept",
      level: "basic",
      model: "gemini-3.6-flash",
      generatedAt: NOW.toISOString(),
    };
    await expect(response.json()).resolves.toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(harness.checks.listByConcept(USER_A, CONCEPT_ID)).resolves.toEqual([expected]);
  });

  it("順に試すモデルの設定が無ければ、GEMINI_MODEL のモデルへ送る", async () => {
    // 送り方の細部は `checks/upstream.test.ts` が固定している。ここは設定から送り先への経路を見る。
    const fetchMock = stubUpstream(generatedCheck());
    silenceInfo();

    await generate(buildApp(), CONCEPT_BASIC, { ...ENV, GEMINI_MODEL: "gemini-3.8-flash" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    );
  });

  it("1組の生成につき ai_usage を1回数える", async () => {
    stubUpstream(generatedCheck(), 1500);
    silenceInfo();
    const harness = buildApp();

    await generate(harness);
    await generate(harness);

    expect(await usedToday(harness)).toBe(2);
  });

  it("日の上限に達していたら上流を叩かず、作ってある問題は解けると伝える", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    silenceInfo();
    const harness = buildApp();
    for (let i = 0; i < AI_USAGE_LIMITS.dailyRequests; i++) await generate(harness);
    fetchMock.mockClear();

    const response = await generate(harness);

    expect(response.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: "ai usage limit reached",
      limit: "daily",
      message: expect.stringContaining("作ってある問題は、回数を使わずにそのまま解けます"),
    });
  });

  it("plus のプランなら、free の日の上限を超えても作れる（#289）", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    silenceInfo();
    const harness = buildApp();
    harness.plans.set(USER_A, "plus");
    for (let i = 0; i < AI_USAGE_LIMITS.dailyRequests; i++) await generate(harness);

    const response = await generate(harness);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(AI_USAGE_LIMITS.dailyRequests + 1);
  });

  it("テスト中に上限を外したときは、日の上限を超えても作れ、回数は記録する", async () => {
    // vars.CHECK_GENERATION_LIMITS: "off"（#255 で戻す）。
    const fetchMock = stubUpstream(generatedCheck());
    silenceInfo();
    const harness = buildApp([], { enforceUsageLimits: false });
    for (let i = 0; i < AI_USAGE_LIMITS.dailyRequests; i++) await generate(harness);

    const response = await generate(harness);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(AI_USAGE_LIMITS.dailyRequests + 1);
    expect(await usedToday(harness)).toBe(AI_USAGE_LIMITS.dailyRequests + 1);
  });

  it("同意が無ければ、送る前に止めて回数も使わない", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    const harness = buildApp();

    const response = await generate(harness, { ...CONCEPT_BASIC, consentVersion: undefined });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "check generation consent required",
      version: CHECK_GENERATION_CONSENT_VERSION,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await usedToday(harness)).toBe(0);
  });

  it("古い版へのその場の同意では生成しない", async () => {
    const fetchMock = stubUpstream(generatedCheck());

    const response = await generate(buildApp(), {
      ...CONCEPT_BASIC,
      consentVersion: CHECK_GENERATION_CONSENT_VERSION - 1,
    });

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("「今後表示しない」の記録が今の版なら、その場の同意なしで生成する", async () => {
    stubUpstream(generatedCheck());
    silenceInfo();
    const harness = buildApp();
    await harness.consents.put(USER_A, {
      version: CHECK_GENERATION_CONSENT_VERSION,
      grantedAt: "2026-09-01T00:00:00.000Z",
    });

    const response = await generate(harness, { ...CONCEPT_BASIC, consentVersion: undefined });

    expect(response.status).toBe(200);
  });

  it("「理解すること」を狙うと、その項目だけを的にし、項目 ID を付けて保存する", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    silenceInfo();

    const response = await generate(buildApp(OBJECTIVES), OBJECTIVE_BASIC);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scope: "objective",
      objectiveId: OBJECTIVE_ID,
    });
    expect(sentPrompt(fetchMock)).toContain(
      "次の「理解すること」1項目だけを出題の的にする: 値レシーバには複製が渡る",
    );
  });

  it("生成の間に作成者が固定の項目を消したら、その項目の組を書き戻さない（#245）", async () => {
    const harness = buildApp(OBJECTIVES);
    const fetchMock = stubUpstream(generatedCheck());
    const upstream = fetchMock.getMockImplementation() as () => Promise<Response>;
    // 上流を待っている間に、作成者が確定でこの項目を消す。
    fetchMock.mockImplementationOnce(async () => {
      await harness.maps.replaceFixedObjectives({
        expectedRevision: null,
        revision: "r1",
        conceptId: CONCEPT_ID,
        objectives: [{ ...OBJECTIVES[1]!, source: "manual" }],
        nowIso: NOW.toISOString(),
      });
      return upstream();
    });
    silenceInfo();

    const response = await generate(harness, OBJECTIVE_BASIC);

    expect(response.status).toBe(409);
    expect(await harness.checks.listByConcept("user-a", CONCEPT_ID)).toEqual([]);
  });

  it("項目ごとに別の組として保存し、同じ項目で作り直すと上書きする", async () => {
    stubUpstream(generatedCheck());
    silenceInfo();
    const harness = buildApp(OBJECTIVES);

    await generate(harness, OBJECTIVE_BASIC);
    await generate(harness, { ...OBJECTIVE_BASIC, objectiveId: `${CONCEPT_ID}:choose` });
    await generate(harness, { ...OBJECTIVE_BASIC, level: "advanced" });

    const saved = await harness.checks.listByConcept(USER_A, CONCEPT_ID);
    expect(saved.map((check) => [check.objectiveId, check.level]).sort()).toEqual([
      [`${CONCEPT_ID}:choose`, "basic"],
      [OBJECTIVE_ID, "advanced"],
    ]);
  });

  it.each([
    ["項目の指定が無い", { scope: "objective" }],
    ["別の Concept の項目を指定した", { scope: "objective", objectiveId: "go.defer:timing" }],
    ["項目以外の範囲で項目を指定した", { scope: "concept", objectiveId: OBJECTIVE_ID }],
  ])("%s要求は上流へ送らずに弾く", async (_, override) => {
    const fetchMock = stubUpstream(generatedCheck());

    const response = await generate(buildApp(OBJECTIVES), { ...CONCEPT_BASIC, ...override });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid objective" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("その項目で自力解決した質問を材料としてプロンプトへ渡し、件数を記録する", async () => {
    // 集め方の細部（件数・順序・渡す範囲）は `checks/material.test.ts` が固定している。
    const fetchMock = stubUpstream(generatedCheck());
    const info = silenceInfo();
    const harness = buildApp(OBJECTIVES);
    await seedSolvedConversation(
      harness,
      "conv-1",
      "2026-09-01T00:00:00.000Z",
      "値レシーバで n++ が効かない",
    );

    await generate(harness, OBJECTIVE_BASIC);

    const prompt = sentPrompt(fetchMock);
    expect(prompt).toContain("<<<質問1\n値レシーバで n++ が効かない\n質問1>>>");
    expect(prompt).not.toContain("SELECTED-CODE-SECRET");
    expect(prompt).not.toContain("ASSISTANT-ANSWER");
    expect(info).toHaveBeenCalledWith(
      "check generation completed",
      expect.objectContaining({ materialCount: 1 }),
    );
  });

  it("項目を持つ Concept では、項目を狙わない組を作らない", async () => {
    // 正誤が項目の理解度に効かない組になるため（#223 決定 6、#236 の決定）。
    const fetchMock = stubUpstream(generatedCheck());

    const response = await generate(buildApp(OBJECTIVES), CONCEPT_BASIC);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid objective" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("生成中に学習データが削除されたら、作った問題を保存しない", async () => {
    const harness = buildApp(OBJECTIVES);
    silenceInfo();
    // 上流を待っている間に削除が終わった状態を作る。
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        await harness.events.deleteByUser(USER_A, NOW.getTime());
        return new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: generatedCheck() }] }, finishReason: "STOP" },
            ],
            usageMetadata: { totalTokenCount: 900 },
          }),
          { status: 200 },
        );
      }),
    );

    const response = await generate(harness, OBJECTIVE_BASIC);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "check discarded by reset" });
    await expect(harness.checks.listAllByUser(USER_A)).resolves.toEqual([]);
  });

  it("本文が使えない応答でも、消費したトークンを利用量へ足す", async () => {
    stubUpstream("", 2048);
    silenceError();
    const harness = buildApp();
    const addTokens = vi.spyOn(InMemoryAiUsageRepository.prototype, "addTokens");

    const response = await generate(harness);

    expect(response.status).toBe(502);
    expect(addTokens).toHaveBeenCalledWith(expect.objectContaining({ tokens: 2048 }));
  });

  it("項目を狙わない組には質問を渡さない", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    silenceInfo();
    const harness = buildApp();
    await seedSolvedConversation(harness, "conv-1", "2026-09-01T00:00:00.000Z", "質問の本文");

    await generate(harness);

    expect(sentPrompt(fetchMock)).not.toContain("質問の本文");
  });

  it("選んだ技術レベルをプロンプトへ伝える", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    silenceInfo();

    await generate(buildApp(), { ...CONCEPT_BASIC, level: "advanced" });

    expect(sentPrompt(fetchMock)).toContain("技術レベル: 応用。");
  });

  it("一覧に無い conceptId は弾く", async () => {
    const fetchMock = stubUpstream(generatedCheck());

    const response = await generate(buildApp(), { ...CONCEPT_BASIC, conceptId: "go.not_defined" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "unknown concept" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["Concept ID の形式", { conceptId: "Go.PointerReceiver" }],
    ["範囲", { scope: "everything" }],
    ["技術レベル", { level: "expert" }],
  ])("%sが契約に無い要求を弾く", async (_, override) => {
    const response = await generate(buildApp(), { ...CONCEPT_BASIC, ...override });

    expect(response.status).toBe(400);
  });

  it("認証が無ければ生成しない", async () => {
    const response = await buildApp().app.request(
      "https://api.example.test/v1/checks:generate",
      { method: "POST", body: JSON.stringify(CONCEPT_BASIC) },
      ENV,
    );

    expect(response.status).toBe(401);
  });

  it("レート制限を掛ける", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await generate(buildApp(), CONCEPT_BASIC, {
      ...ENV,
      PROFILE_RATE_LIMITER: BLOCKING_LIMITER,
    } as unknown as CloudflareBindings);

    expect(response.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("許可していないモデルの設定では生成しない", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    const error = silenceError();

    const response = await generate(buildApp(), CONCEPT_BASIC, {
      ...ENV,
      GEMINI_MODEL: "gemini-3.5-pro-expensive",
    } as unknown as CloudflareBindings);

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it("API キー未設定は運営側の障害として記録する", async () => {
    const error = silenceError();

    const response = await generate(buildApp(), CONCEPT_BASIC, {
      PROFILE_RATE_LIMITER: PASSING_LIMITER,
    } as unknown as CloudflareBindings);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "AI service is not configured",
      message: expect.stringContaining("運営に連絡してください"),
    });
    expect(error).toHaveBeenCalled();
  });

  it("上流の失敗は 502 とし、状態コードと理由を利用者へ伝える", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(new Response("nope", { status: 500 }))),
    );
    const error = silenceError();

    const response = await generate(buildApp());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: "AI upstream request failed",
      reason: "upstream-status",
      status: 500,
      message: expect.stringMatching(
        /^AI の呼び出しに失敗しました（状態 500）。時間をおいて、もう一度お試しください。［詳細: /,
      ),
      // JSON でない本文は、そのまま文として添える。
      upstream: { upstreamMessage: "nope" },
    });
    expect(error).toHaveBeenCalled();
  });

  it("送り直して作れたら、応答したモデルを記録し、回数は1回だけ数える", async () => {
    // 送り直しの規則は `checks/upstream.test.ts` が固定している。ここは生成の結果への反映を見る。
    const success = JSON.stringify({
      candidates: [{ content: { parts: [{ text: generatedCheck() }] }, finishReason: "STOP" }],
      usageMetadata: { totalTokenCount: 900 },
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(new Response("busy", { status: 503 })))
      .mockImplementationOnce(() => Promise.resolve(new Response(success, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    silenceWarn();
    silenceInfo();
    const harness = buildApp([], { models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"] });

    const response = await generate(harness);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(response.json()).resolves.toMatchObject({ model: "gemini-3.5-flash-lite" });
    await expect(harness.checks.listByConcept(USER_A, CONCEPT_ID)).resolves.toMatchObject([
      { model: "gemini-3.5-flash-lite" },
    ]);
    expect(await usedToday(harness)).toBe(1);
  });

  it("順に試すモデルに許可外が1つでもあれば、どこへも送らずに設定の誤りとする", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    silenceError();

    const response = await generate(
      buildApp([], { models: ["gemini-3.8-flash", "gemini-3.5-pro-expensive"] }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "AI service is not configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("2問揃わない応答を受理せず、理由を利用者へ伝え、保存しない", async () => {
    stubUpstream(JSON.stringify({ conceptId: CONCEPT_ID, overview: question() }));
    silenceInfo();
    silenceError();
    const harness = buildApp();

    const response = await generate(harness);

    expect(response.status).toBe(502);
    const body = (await response.json()) as { reason: string; message: string };
    expect(body.reason).toBe("shape");
    expect(body.message).toContain("2問1組");
    // 検証の詳細（モデルの応答の断片）は利用者へ返さない。
    expect(Object.keys(body).sort()).toEqual(["error", "message", "reason"]);
    await expect(harness.checks.listAllByUser(USER_A)).resolves.toEqual([]);
  });

  it("正解が選択肢に無い応答を受理しない", async () => {
    stubUpstream(generatedCheck({ overview: question({ answerIndex: 9 }) }));
    silenceInfo();
    silenceError();

    const response = await generate(buildApp());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      reason: "answer-out-of-range",
      message: expect.stringContaining("正解が選択肢"),
    });
  });

  it("別の Concept の問題を受理しない", async () => {
    stubUpstream(generatedCheck({ conceptId: "go.slice_append" }));
    silenceInfo();
    silenceError();

    const response = await generate(buildApp());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ reason: "concept-mismatch" });
  });

  it("本文の無い応答は、上流の終了理由を添えて利用者へ伝える", async () => {
    // 本番のログを見られないので、空の応答の原因は応答本文から切り分ける。
    stubUpstream("");
    silenceError();

    const response = await generate(buildApp());

    expect(response.status).toBe(502);
    const body = (await response.json()) as {
      reason: string;
      finishReason: string;
      message: string;
    };
    expect(body).toMatchObject({ reason: "no-text", finishReason: "STOP" });
    expect(body.message).toContain("STOP");
  });

  it("問題として読めない応答を受理しない", async () => {
    stubUpstream("ごめんなさい、問題を作れませんでした。");
    silenceInfo();
    silenceError();

    const response = await generate(buildApp());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ reason: "not-json" });
  });

  it("保存に失敗したら問題を返さず失敗にする", async () => {
    // 問題だけ返すと、次に開いたときに問題が無く、回数だけが減っている。
    stubUpstream(generatedCheck());
    silenceInfo();
    const harness = buildApp();
    harness.checks.put = () => Promise.reject(new Error("D1 is unavailable"));
    const error = silenceError();
    harness.app.onError((err, c) => {
      console.error("unhandled error", { message: err.message });
      return c.json({ error: "internal server error" }, 500);
    });

    const response = await generate(harness);

    expect(response.status).toBe(500);
    expect(error).toHaveBeenCalledWith("unhandled error", { message: "D1 is unavailable" });
  });
});

describe("手で作ったマップのノード（#242）", () => {
  const MAP_OBJECTIVE = {
    conceptId: TEST_MAP_NODE.id,
    scope: "objective",
    level: "basic",
    objectiveId: TEST_MAP_OBJECTIVES[0]!.id,
    consentVersion: CHECK_GENERATION_CONSENT_VERSION,
  };

  it("マップの題名・概要・前提を入力にして作り、保存する", async () => {
    const fetchMock = stubUpstream(generatedCheck({ conceptId: TEST_MAP_NODE.id }));
    silenceInfo();
    const harness = buildApp();
    await seedTestMap(harness.maps, USER_A);

    const response = await generate(harness, MAP_OBJECTIVE);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      conceptId: TEST_MAP_NODE.id,
      scope: "objective",
      objectiveId: TEST_MAP_OBJECTIVES[0]!.id,
    });
    const prompt = sentPrompt(fetchMock);
    // 領域はマップの ID ではなく題名で渡す。
    expect(prompt).toContain(`領域: ${TEST_MAP_TITLE}`);
    expect(prompt).not.toContain("領域: mrust0001");
    expect(prompt).toContain(TEST_MAP_NODE.summary);
    expect(prompt).toContain(TEST_MAP_BASE.label);
    expect(prompt).toContain(TEST_MAP_OBJECTIVES[0]!.label);
    await expect(harness.checks.listByConcept(USER_A, TEST_MAP_NODE.id)).resolves.toHaveLength(1);
  });

  it("項目を持つノードでは、項目を狙わない組を作らない", async () => {
    const fetchMock = stubUpstream(generatedCheck({ conceptId: TEST_MAP_NODE.id }));
    const harness = buildApp();
    await seedTestMap(harness.maps, USER_A);

    const response = await generate(harness, {
      ...CONCEPT_BASIC,
      conceptId: TEST_MAP_NODE.id,
    });

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("他の利用者のマップのノードでは作らない", async () => {
    const fetchMock = stubUpstream(generatedCheck({ conceptId: TEST_MAP_NODE.id }));
    const harness = buildApp();
    await seedTestMap(harness.maps, "auth0|user-b");

    const response = await generate(harness, MAP_OBJECTIVE);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "unknown concept" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["マップ", (harness: Harness) => harness.maps.delete(USER_A, TEST_MAP_ID)],
    [
      "狙った項目",
      (harness: Harness) =>
        harness.maps.replaceObjectives(USER_A, {
          mapId: TEST_MAP_ID,
          conceptId: TEST_MAP_NODE.id,
          objectives: [{ ...TEST_MAP_OBJECTIVES[1]!, source: "manual" }],
          nowIso: NOW.toISOString(),
          nowMs: NOW.getTime(),
        }),
    ],
  ])("生成中に%sが消されたら、作った問題を保存しない", async (_name, remove) => {
    const fetchMock = stubUpstream(generatedCheck({ conceptId: TEST_MAP_NODE.id }));
    silenceInfo();
    const harness = buildApp();
    await seedTestMap(harness.maps, USER_A);
    // 上流が答える前に、別の端末で消された状態を作る。
    const respond = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      await remove(harness);
      return respond(...args);
    });

    const response = await generate(harness, MAP_OBJECTIVE);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "check discarded by map change",
    });
    await expect(harness.checks.listByConcept(USER_A, TEST_MAP_NODE.id)).resolves.toEqual([]);
  });

  it("別のノードの項目は狙えない", async () => {
    const fetchMock = stubUpstream(generatedCheck({ conceptId: TEST_MAP_BASE.id }));
    const harness = buildApp();
    await seedTestMap(harness.maps, USER_A);

    const response = await generate(harness, { ...MAP_OBJECTIVE, conceptId: TEST_MAP_BASE.id });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid objective" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /v1/checks", () => {
  it("保存済みの組を、AI を呼ばず回数も使わずに返す", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    silenceInfo();
    const harness = buildApp();
    await generate(harness);
    fetchMock.mockClear();

    const response = await call(harness, `/checks?conceptId=${CONCEPT_ID}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { checks: unknown[] };
    expect(body.checks).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await usedToday(harness)).toBe(1);
  });

  it("他人の問題は返さない", async () => {
    stubUpstream(generatedCheck());
    silenceInfo();
    const harness = buildApp();
    await generate(harness);

    const response = await call(harness, `/checks?conceptId=${CONCEPT_ID}`, {}, "other-token");

    await expect(response.json()).resolves.toEqual({ checks: [] });
  });

  it("Concept ID の形式を満たさない要求を弾く", async () => {
    const response = await call(buildApp(), "/checks?conceptId=Not.Valid");

    expect(response.status).toBe(400);
  });
});

describe("GET /v1/checks:export", () => {
  it("本人の全件を返し、監査ログに残す", async () => {
    stubUpstream(generatedCheck());
    silenceInfo();
    const harness = buildApp();
    await generate(harness);

    const response = await call(harness, "/checks:export");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      version: 1,
      exportedAt: NOW.toISOString(),
      checks: [{ conceptId: CONCEPT_ID, scope: "concept" }],
    });
    expect(harness.store.auditLog).toContainEqual(
      expect.objectContaining({
        userId: USER_A,
        action: "concept_checks.exported",
        detail: { checkCount: 1 },
      }),
    );
  });
});

describe("/v1/check-generation-consent", () => {
  it("記録が無ければ未同意として今の版を返す", async () => {
    const response = await call(buildApp(), "/check-generation-consent");

    await expect(response.json()).resolves.toEqual({
      version: CHECK_GENERATION_CONSENT_VERSION,
      granted: false,
    });
  });

  it("今の版で記録し、取り消せる", async () => {
    const harness = buildApp();

    const put = await call(harness, "/check-generation-consent", {
      method: "PUT",
      body: JSON.stringify({ version: CHECK_GENERATION_CONSENT_VERSION }),
    });
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toEqual({
      version: CHECK_GENERATION_CONSENT_VERSION,
      granted: true,
      grantedAt: NOW.toISOString(),
    });

    const deleted = await call(harness, "/check-generation-consent", { method: "DELETE" });
    await expect(deleted.json()).resolves.toMatchObject({ granted: false });
    await expect(harness.consents.get(USER_A)).resolves.toBeNull();
  });

  it("古い版への同意は記録しない", async () => {
    const harness = buildApp();

    const response = await call(harness, "/check-generation-consent", {
      method: "PUT",
      body: JSON.stringify({ version: CHECK_GENERATION_CONSENT_VERSION - 1 }),
    });

    expect(response.status).toBe(409);
    await expect(harness.consents.get(USER_A)).resolves.toBeNull();
  });

  it("古い版の記録は同意として扱わない", async () => {
    const harness = buildApp();
    await harness.consents.put(USER_A, {
      version: CHECK_GENERATION_CONSENT_VERSION - 1,
      grantedAt: "2026-09-01T00:00:00.000Z",
    });

    const response = await call(harness, "/check-generation-consent");

    await expect(response.json()).resolves.toMatchObject({ granted: false });
  });
});
