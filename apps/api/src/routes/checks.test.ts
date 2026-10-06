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
  InMemoryPersonalCheckRepository,
  type InMemoryRepositoryStore,
} from "../repository/memory.js";
import { createAiRoute } from "./ai.js";
import { createChecksRoute, parseModelList } from "./checks.js";

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
  const usage = new InMemoryAiUsageRepository();
  const identity = new InMemoryIdentityRepository(store);
  const checks = new InMemoryPersonalCheckRepository(store);
  const consents = new InMemoryCheckGenerationConsentRepository(store);
  const events = new InMemoryLearningEventRepository(store);
  const conversations = new InMemoryConversationRepository(store);
  const settings = new InMemoryUserSettingsRepository();
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
      identity,
      audit: new InMemoryAuditLogRepository(store),
      objectives,
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
      identity,
      now: () => NOW,
    })),
  );
  return { app, store, checks, consents, events, conversations, settings };
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

  it("上流へはタイムアウトと出力上限を付けて送る", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    silenceInfo();

    await generate(buildApp());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
    );
    // 単発の外向き fetch なので壁時計で切る（RULE-001）。
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // 資格情報を載せるのでリダイレクトを追跡しない（RULE-002）。Workers は
    // `redirect: "error"` を実装しておらず送信前に例外を投げるので `manual`（#253）。
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(String(init.body))).toMatchObject({
      generationConfig: {
        maxOutputTokens: AI_USAGE_LIMITS.outputTokensPerRequest,
        responseMimeType: "application/json",
      },
    });
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

  it("その項目で自力解決した質問の本文だけを、新しい順に3件まで材料に渡す", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    const info = silenceInfo();
    const harness = buildApp(OBJECTIVES);
    for (const [index, day] of ["01", "02", "03", "04"].entries()) {
      await seedSolvedConversation(
        harness,
        `conv-${String(index)}`,
        `2026-09-${day}T00:00:00.000Z`,
        `質問${String(index)}: 値レシーバで n++ が効かない`,
      );
    }

    await generate(harness, OBJECTIVE_BASIC);

    const prompt = sentPrompt(fetchMock);
    expect(prompt).toContain("<<<質問1\n質問3: 値レシーバで n++ が効かない\n質問1>>>");
    expect(prompt).toContain("<<<質問3\n質問1: 値レシーバで n++ が効かない\n質問3>>>");
    expect(prompt).not.toContain("質問0:");
    // 選択したコードと AI の回答は送らない（#236 の決定）。
    expect(prompt).not.toContain("SELECTED-CODE-SECRET");
    expect(prompt).not.toContain("ASSISTANT-ANSWER");
    expect(info).toHaveBeenCalledWith(
      "check generation completed",
      expect.objectContaining({ materialCount: 3 }),
    );
  });

  it("質問は上限の文字数で切る", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    silenceInfo();
    const harness = buildApp(OBJECTIVES);
    await seedSolvedConversation(
      harness,
      "conv-long",
      "2026-09-01T00:00:00.000Z",
      "あ".repeat(700),
    );

    await generate(harness, OBJECTIVE_BASIC);

    expect(sentPrompt(fetchMock)).toContain(`<<<質問1\n${"あ".repeat(600)}\n質問1>>>`);
  });

  it("会話が保存されていなければ、材料なしで1組作る", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    silenceInfo();
    const harness = buildApp(OBJECTIVES);
    await seedSolvedConversation(harness, "conv-1", "2026-09-01T00:00:00.000Z", "質問");
    await harness.conversations.deleteAllByUser(USER_A);

    const response = await generate(harness, OBJECTIVE_BASIC);

    expect(response.status).toBe(200);
    expect(sentPrompt(fetchMock)).not.toContain("自力で解決した質問");
  });

  it("「質問履歴の保存」を後から無効にした人の会話は、保存済みでも渡さない", async () => {
    // 無効にしても保存済みの履歴は残る。同意の文面は「有効にしているときだけ」と約束している。
    const fetchMock = stubUpstream(generatedCheck());
    const info = silenceInfo();
    const harness = buildApp(OBJECTIVES);
    await seedSolvedConversation(harness, "conv-1", "2026-09-01T00:00:00.000Z", "保存済みの質問");
    await harness.settings.put(
      USER_A,
      { saveConversationHistory: false },
      "2026-09-02T00:00:00.000Z",
    );

    const response = await generate(harness, OBJECTIVE_BASIC);

    expect(response.status).toBe(200);
    expect(sentPrompt(fetchMock)).not.toContain("保存済みの質問");
    expect(info).toHaveBeenCalledWith(
      "check generation completed",
      expect.objectContaining({ materialCount: 0 }),
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

  it("長い質問が揃っても入力の上限に収まるまで削り、生成できる", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    silenceInfo();
    const harness = buildApp(OBJECTIVES);
    for (const [index, day] of ["01", "02", "03"].entries()) {
      await seedSolvedConversation(
        harness,
        `conv-${String(index)}`,
        `2026-09-${day}T00:00:00.000Z`,
        `質問${String(index)}` + "長".repeat(700),
      );
    }

    const response = await generate(harness, OBJECTIVE_BASIC);

    expect(response.status).toBe(200);
    const prompt = sentPrompt(fetchMock);
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(
      AI_USAGE_LIMITS.inputTokensPerRequest,
    );
    // 新しい質問から載せる。
    expect(prompt).toContain("<<<質問1\n質問2長");
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

  it("他人の会話は材料にしない", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    silenceInfo();
    const harness = buildApp(OBJECTIVES);
    await seedSolvedConversation(harness, "conv-1", "2026-09-01T00:00:00.000Z", "A さんの質問");

    await generate(harness, OBJECTIVE_BASIC, ENV, "other-token");

    expect(sentPrompt(fetchMock)).not.toContain("A さんの質問");
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

  it("Gemini のエラー本文の要点と送信の経過を、応答と画面の文に添える", async () => {
    // 原因（混雑か割り当て超過か）を本番で切り分けるため（#253）。
    const geminiError = JSON.stringify({
      error: {
        code: 429,
        message: "You exceeded your current quota. key=AIzaSyA1234567890abcdefghijklmnop",
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }],
          },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "33s" },
        ],
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(new Response(geminiError, { status: 429 }))),
    );
    silenceError();

    const response = await generate(buildApp());

    expect(response.status).toBe(502);
    const body = (await response.json()) as { message: string; upstream: unknown };
    expect(body.upstream).toMatchObject({
      attempts: 1,
      statuses: [429],
      upstreamStatus: "RESOURCE_EXHAUSTED",
      quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
      retryDelay: "33s",
      elapsedMs: expect.any(Number),
    });
    // キーらしい文字列は伏せる。
    expect(JSON.stringify(body)).not.toContain("AIza");
    expect(body.message).toContain("RESOURCE_EXHAUSTED / GenerateRequestsPerDayPerProjectPerModel");
    expect(body.message).toContain("「You exceeded your current quota. key=[redacted]」");
    expect(body.message).toContain("1 回送信（429）");
  });

  it("上流が混雑（503）を返したら、送り直して生成する", async () => {
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
    const harness = buildApp();

    const response = await generate(harness);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 送り直しても、回数は1回だけ数える。
    expect(await usedToday(harness)).toBe(1);
  });

  it("先頭のモデルが混雑（503）なら、待たずに次のモデルで生成し、そのモデルを記録する", async () => {
    // 混雑はモデルごとなので、同じモデルを待つより別のモデルへ回す（#268）。
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
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain("/models/gemini-3.8-flash:generateContent");
    expect(urls[1]).toContain("/models/gemini-3.5-flash-lite:generateContent");
    await expect(response.json()).resolves.toMatchObject({ model: "gemini-3.5-flash-lite" });
    expect(await usedToday(harness)).toBe(1);
  });

  it("どのモデルも混雑なら、巡ごとに全部を試してから、モデルごとの結果を伝える", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("busy", { status: 503 })));
    vi.stubGlobal("fetch", fetchMock);
    silenceWarn();
    silenceError();

    const response = await generate(
      buildApp([], { models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"] }),
    );

    expect(response.status).toBe(502);
    // 待ち時間 2 つ → 3 巡 × 2 モデル。
    expect(fetchMock).toHaveBeenCalledTimes(6);
    await expect(response.json()).resolves.toMatchObject({
      reason: "upstream-status",
      status: 503,
      upstream: {
        attempts: 6,
        models: [
          "gemini-3.8-flash",
          "gemini-3.5-flash-lite",
          "gemini-3.8-flash",
          "gemini-3.5-flash-lite",
          "gemini-3.8-flash",
          "gemini-3.5-flash-lite",
        ],
      },
      message: expect.stringContaining(
        "6 回送信（gemini-3.8-flash 503, gemini-3.5-flash-lite 503, gemini-3.8-flash 503,",
      ),
    });
  });

  it("要求の誤り（4xx）なら、次のモデルへ回さない", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("bad", { status: 400 })));
    vi.stubGlobal("fetch", fetchMock);
    silenceError();

    const response = await generate(
      buildApp([], { models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"] }),
    );

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("混雑が続けば、決めた回数だけ送り直してから失敗を伝える", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("busy", { status: 503 })));
    vi.stubGlobal("fetch", fetchMock);
    silenceWarn();
    silenceError();

    const response = await generate(buildApp());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      reason: "upstream-status",
      status: 503,
      upstream: { attempts: 3, statuses: [503, 503, 503] },
      message: expect.stringContaining("3 回送信（503, 503, 503）"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("503 の本文が壊れていても、送り直す", async () => {
    // 本文を捨てる処理の失敗を、接続の失敗として扱わない。
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new Error("connection closed"));
      },
    });
    const success = JSON.stringify({
      candidates: [{ content: { parts: [{ text: generatedCheck() }] }, finishReason: "STOP" }],
      usageMetadata: { totalTokenCount: 900 },
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(broken, { status: 503 })))
      .mockImplementationOnce(() => Promise.resolve(new Response(success, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    silenceWarn();
    silenceInfo();

    const response = await generate(buildApp());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("要求の誤り（4xx）は送り直さない", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("bad", { status: 400 })));
    vi.stubGlobal("fetch", fetchMock);
    silenceError();

    const response = await generate(buildApp());

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("上流が転送（3xx）を返したら、追わずに失敗として扱う", async () => {
    // `redirect: "manual"` では 3xx がそのまま返る。API キーを転送先へ送り直さない（#253）。
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    silenceError();

    const response = await generate(buildApp());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      reason: "upstream-status",
      status: 302,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("上流へ届かなかった場合も 502 とし、届かなかったことを伝える", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.reject(new TypeError("network unreachable"))),
    );
    const error = silenceError();

    const response = await generate(buildApp());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      reason: "upstream-unreachable",
      message: expect.stringContaining("AI に接続できませんでした"),
      upstream: { attempts: 1, statuses: [], cause: "TypeError: network unreachable" },
    });
    expect(error).toHaveBeenCalled();
  });

  it("時間切れは、時間内に返らなかったことを伝える", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
        ),
    );
    silenceError();

    const response = await generate(buildApp());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      reason: "upstream-timeout",
      message: expect.stringContaining("時間内に返りませんでした"),
    });
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
