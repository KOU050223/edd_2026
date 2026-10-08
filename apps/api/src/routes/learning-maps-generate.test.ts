import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  MAP_GENERATION_CONSENT_VERSION,
  type Concept,
  type LearningObjective,
} from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import { stubAuth } from "../auth/test-auth.js";
import { AI_USAGE_LIMITS, utcDayKey, utcMonthKey } from "../contract/ai-usage.js";
import {
  MAP_GENERATION_USAGE_COST,
  MAX_MAPS_PER_USER,
  type GenerateCreationChecksResponse,
  type GenerateLearningMapResponse,
  type LearningMapView,
  type MapGenerationConsentBody,
} from "../contract/learning-maps.js";
import { InMemoryAiUsageRepository } from "../repository/ai-usage.js";
import { InMemoryMasteryOverrideRepository } from "../repository/mastery-overrides.js";
import {
  createInMemoryRepositoryStore,
  InMemoryIdentityRepository,
  InMemoryLearningEventRepository,
  InMemoryLearningMapRepository,
  InMemoryMapGenerationConsentRepository,
  InMemoryPersonalCheckRepository,
} from "../repository/memory.js";
import { CREATION_CHECKS_LEASE_MS } from "../maps/creation-checks.js";
import { createLearningMapsRoute } from "./learning-maps.js";

const NOW = new Date("2026-10-08T09:00:00.000Z");
const USAGE_KEYS = { monthKey: utcMonthKey(NOW), dayKey: utcDayKey(NOW) };
const TOKENS = { "token-a": "user-a" };
/** 呼ばれた回数を数える、常に通す制限。 */
const limiterCalls = { count: 0 };
const PASSING_LIMITER = {
  limit: () => {
    limiterCalls.count++;
    return Promise.resolve({ success: true });
  },
} as unknown as RateLimit;
const ENV = { PROFILE_RATE_LIMITER: PASSING_LIMITER } as unknown as CloudflareBindings;

const FIXED_CONCEPTS: Concept[] = [
  {
    id: "go.defer",
    label: "defer",
    language: "go",
    summary: "関数を抜けるときに実行する。",
    prerequisites: [],
    source: { kind: "manual" },
  },
  // 項目を持たないので、参照の候補に入らない（#243 の決定 J4）。
  {
    id: "go.goroutine",
    label: "goroutine",
    language: "go",
    summary: "軽量なスレッド。",
    prerequisites: [],
    source: { kind: "manual" },
  },
];
const FIXED_OBJECTIVES: LearningObjective[] = [
  { id: "go.defer:execution_timing", conceptId: "go.defer", label: "実行タイミング" },
];

let maps: InMemoryLearningMapRepository;
let usage: InMemoryAiUsageRepository;
let consents: InMemoryMapGenerationConsentRepository;
let checks: InMemoryPersonalCheckRepository;
/** 作成時の確認問題の本文を、頼まれた Concept ID の並びから作る。テストごとに差し替える。 */
let creationChecksFor: (conceptIds: string[]) => string;
let fetchMock: ReturnType<typeof vi.fn>;
let app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;
let keys: number;
/** 骨組みとして返す本文。テストごとに差し替える。 */
let skeletonText: string;
/** 「理解すること」の本文を、頼まれた key から作る。テストごとに差し替える。 */
let objectivesFor: (keys: string[]) => string;

function upstreamBody(text: string) {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { totalTokenCount: 1_000 },
    modelVersion: "gemini-3.6-flash",
  });
}

/** 送ったプロンプトを読む。 */
function promptOf(init: RequestInit | undefined): string {
  const body = JSON.parse(String(init?.body)) as {
    contents: { parts: { text: string }[] }[];
  };
  return body.contents[0]!.parts[0]!.text;
}

function maxOutputTokensOf(init: RequestInit | undefined): number {
  return (JSON.parse(String(init?.body)) as { generationConfig: { maxOutputTokens: number } })
    .generationConfig.maxOutputTokens;
}

/** 「理解すること」のプロンプトに並べたノードの key。 */
function keysInPrompt(prompt: string): string[] {
  return [...prompt.matchAll(/^(n\d+)\|/gm)].map((match) => match[1]!);
}

/** 1組の確認問題（概要問題と実践問題）。 */
function generatedCheck(conceptId: string) {
  const question = {
    prompt: "設問",
    choices: ["a", "b", "c", "d"],
    answerIndex: 0,
    explanation: "解説",
  };
  return { conceptId, overview: question, practice: { ...question, code: "x := 1" } };
}

function ownNodes(count: number, from = 1) {
  return Array.from({ length: count }, (_, index) => {
    const n = from + index;
    return {
      key: `n${String(n)}`,
      label: `ノード${String(n)}`,
      summary: `ノード${String(n)}の概要。`,
      ...(n === 1 ? {} : { prerequisite: `n${String(n - 1)}` }),
    };
  });
}

beforeEach(() => {
  const store = createInMemoryRepositoryStore();
  maps = new InMemoryLearningMapRepository(store);
  usage = new InMemoryAiUsageRepository();
  consents = new InMemoryMapGenerationConsentRepository(store);
  checks = new InMemoryPersonalCheckRepository(store);
  creationChecksFor = (conceptIds) =>
    JSON.stringify({ checks: conceptIds.map((conceptId) => generatedCheck(conceptId)) });
  keys = 0;
  skeletonText = JSON.stringify({
    title: "Go で Web API",
    description: "HTTP から認証まで。",
    nodes: [
      { key: "n1", conceptId: "go.defer" },
      { key: "n2", label: "HTTP の基本", summary: "リクエストとレスポンス。", prerequisite: "n1" },
      { key: "n3", label: "ハンドラ", summary: "net/http で書く。", prerequisite: "n2" },
    ],
  });
  objectivesFor = (requested) =>
    JSON.stringify({
      nodes: requested.map((key) => ({ key, objectives: [`${key} の項目1`, `${key} の項目2`] })),
    });
  fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    const prompt = promptOf(init);
    const text = prompt.includes("確認問題を作る出題者")
      ? creationChecksFor([...prompt.matchAll(/^ID: (\S+)$/gm)].map((match) => match[1]!))
      : prompt.includes("「理解すること」を作ってください")
        ? objectivesFor(keysInPrompt(prompt))
        : skeletonText;
    return Promise.resolve(new Response(upstreamBody(text), { status: 200 }));
  });
  const identity = new InMemoryIdentityRepository(store);
  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth(TOKENS));
  app.route(
    "/v1",
    createLearningMapsRoute(() => ({
      identity,
      maps,
      fixedConcepts: FIXED_CONCEPTS,
      fixedObjectives: FIXED_OBJECTIVES,
      newKey: () => `k${String(++keys).padStart(7, "0")}`,
      nowIso: () => NOW.toISOString(),
      nowMs: () => NOW.getTime(),
      generation: {
        apiKey: "test-key",
        model: "gemini-3.6-flash",
        fetch: fetchMock as unknown as typeof fetch,
        usage,
        checks,
        consents,
        events: new InMemoryLearningEventRepository(store),
        overrides: new InMemoryMasteryOverrideRepository(),
        retryDelaysMs: [],
        now: () => NOW,
      },
    })),
  );
});

function send(method: string, path: string, body?: unknown) {
  return app.request(
    `/v1${path}`,
    {
      method,
      headers: {
        Authorization: "Bearer token-a",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    ENV,
  );
}

/** その場の同意なしの、目標までのマップの要求。 */
const GOAL_WITHOUT_CONSENT = { kind: "goal", theme: "Go", goal: "Web API を作る", level: "basic" };
const GOAL_REQUEST = { ...GOAL_WITHOUT_CONSENT, consentVersion: MAP_GENERATION_CONSENT_VERSION };

async function usedRequests() {
  return (await usage.get({ userId: "user-a", ...USAGE_KEYS })).dailyRequests;
}

describe("POST /v1/learning-maps:generate", () => {
  it("骨組みと「理解すること」を作り、手で作るマップと同じ形で保存して返す", async () => {
    const res = await send("POST", "/learning-maps:generate", GOAL_REQUEST);

    expect(res.status).toBe(201);
    const { map } = (await res.json()) as GenerateLearningMapResponse;
    expect(map.title).toBe("Go で Web API");
    expect(map.visibility).toBe("private");
    expect(map.nodes.map((node) => node.kind)).toEqual(["reference", "own", "own"]);
    const [reference, http, handler] = map.nodes;
    expect(reference).toMatchObject({ conceptId: "go.defer", origin: { label: "defer" } });
    // 新しいノードの ID はサーバーが振る（手で作るマップと同じ `<マップ ID>.<識別子>`）。
    expect(http).toMatchObject({ kind: "own", label: "HTTP の基本" });
    expect(http?.conceptId).toMatch(new RegExp(`^${map.id}\\.`));
    expect(http?.kind === "own" && http.objectives).toEqual([
      {
        id: expect.stringMatching(new RegExp(`^${http!.conceptId}:`)) as string,
        label: "n2 の項目1",
        source: "ai",
      },
      { id: expect.any(String) as string, label: "n2 の項目2", source: "ai" },
    ]);
    expect(map.edges).toEqual([
      { from: "go.defer", to: http!.conceptId },
      { from: http!.conceptId, to: handler!.conceptId },
    ]);

    // 保存したものは、手で作るマップの口からも同じに読める（Web/18 の編集画面で直せる）。
    const stored = await send("GET", `/learning-maps/${map.id}`);
    expect(await stored.json()).toEqual(map);

    // 骨組み1回 + 「理解すること」1回。回数は呼んだ数にかかわらず 5 回分。
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(maxOutputTokensOf(fetchMock.mock.calls[0]![1] as RequestInit)).toBe(8_192);
    expect(maxOutputTokensOf(fetchMock.mock.calls[1]![1] as RequestInit)).toBe(4_096);
    expect(await usedRequests()).toBe(MAP_GENERATION_USAGE_COST);
    const recorded = await usage.get({ userId: "user-a", ...USAGE_KEYS });
    expect(recorded.monthlyTokens).toBe(2_000);
  });

  it("参照の候補には「理解すること」を持つ Concept だけを載せ、利用者の入力は資料として区切る", async () => {
    await send("POST", "/learning-maps:generate", GOAL_REQUEST);

    const prompt = promptOf(fetchMock.mock.calls[0]![1] as RequestInit);
    expect(prompt).toContain("go.defer|defer|未着手");
    expect(prompt).not.toContain("go.goroutine");
    expect(prompt).toContain("<<<目標\nWeb API を作る\n目標>>>");
  });

  it("参照した自分のノードの「理解すること」が生成中に全部消されたら、マップを保存しない", async () => {
    const created = await send("POST", "/learning-maps", {
      title: "元のマップ",
      nodes: [{ kind: "own", ref: "new:a", label: "所有権", summary: "持ち主は1つ。" }],
    });
    const { map: source, assigned } = (await created.json()) as {
      map: LearningMapView;
      assigned: Record<string, string>;
    };
    const referenced = assigned["new:a"]!;
    await send("PUT", `/learning-maps/${source.id}/nodes/${referenced}/objectives`, {
      objectives: [{ label: "代入で持ち主が移る" }],
    });
    skeletonText = JSON.stringify({
      title: "Rust で CLI",
      nodes: [
        { key: "n1", conceptId: referenced },
        { key: "n2", label: "引数", summary: "コマンドライン引数を読む。", prerequisite: "n1" },
      ],
    });
    // 「理解すること」を作っている間に、別の端末で参照先の項目が全部消された。
    objectivesFor = (requested) => {
      void maps.replaceObjectives("user-a", {
        mapId: source.id,
        conceptId: referenced,
        objectives: [],
        nowIso: NOW.toISOString(),
        nowMs: NOW.getTime(),
      });
      return JSON.stringify({
        nodes: requested.map((key) => ({ key, objectives: ["a", "b"] })),
      });
    };

    const res = await send("POST", "/learning-maps:generate", GOAL_REQUEST);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "map discarded by reference change" });
    expect((await maps.listByOwner("user-a")).map((map) => map.id)).toEqual([source.id]);
  });

  it("生成の口はルートで回数を数えない（`app.ts` の `/v1/learning-maps*` が数える）", async () => {
    limiterCalls.count = 0;
    await send("POST", "/learning-maps:generate", GOAL_REQUEST);
    expect(limiterCalls.count).toBe(0);

    // 同意の口は `app.ts` の対象外なので、ルートで数える。
    await send("GET", "/map-generation-consent");
    expect(limiterCalls.count).toBe(1);
  });

  it("新しいノードは 10 個ずつに分けて、並列で「理解すること」を頼む", async () => {
    skeletonText = JSON.stringify({ title: "大きなマップ", nodes: ownNodes(25) });

    const res = await send("POST", "/learning-maps:generate", GOAL_REQUEST);

    expect(res.status).toBe(201);
    const requested = fetchMock.mock.calls
      .slice(1)
      .map(([, init]) => keysInPrompt(promptOf(init as RequestInit)).length);
    expect(requested).toEqual([10, 10, 5]);
    const { map } = (await res.json()) as GenerateLearningMapResponse;
    expect(map.nodes).toHaveLength(25);
    expect(map.nodes.every((node) => node.kind === "own" && node.objectives.length === 2)).toBe(
      true,
    );
    expect(await usedRequests()).toBe(MAP_GENERATION_USAGE_COST);
  });

  it("「理解すること」の1回が形式を満たさなければ、マップを何も残さない", async () => {
    skeletonText = JSON.stringify({ title: "大きなマップ", nodes: ownNodes(15) });
    // 2回目の呼び出し（n11〜n15）だけ、1ノードの項目が足りない。
    objectivesFor = (requested) =>
      JSON.stringify({
        nodes: requested.map((key) => ({
          key,
          objectives: key === "n12" ? ["1つだけ"] : ["a", "b"],
        })),
      });

    const res = await send("POST", "/learning-maps:generate", GOAL_REQUEST);

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: "map generation failed",
      reason: "objectives",
    });
    expect(await maps.listByOwner("user-a")).toEqual([]);
    // 上流へは送ったので、回数は戻さない。
    expect(await usedRequests()).toBe(MAP_GENERATION_USAGE_COST);
  });

  it("骨組みが木の形でなければ、「理解すること」を頼まずに失敗にする", async () => {
    skeletonText = JSON.stringify({
      title: "壊れたマップ",
      nodes: [
        { key: "n1", label: "a", summary: "a", prerequisite: "n2" },
        { key: "n2", label: "b", summary: "b" },
      ],
    });

    const res = await send("POST", "/learning-maps:generate", GOAL_REQUEST);

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ reason: "structure" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await maps.listByOwner("user-a")).toEqual([]);
  });

  it("上流が失敗したら、何も保存しない", async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response("{}", { status: 400 })));

    const res = await send("POST", "/learning-maps:generate", GOAL_REQUEST);

    expect(res.status).toBe(502);
    expect(await maps.listByOwner("user-a")).toEqual([]);
  });

  it("5 回分の枠が残っていなければ、上流を叩かずに 429 を返す", async () => {
    for (let i = 0; i < AI_USAGE_LIMITS.dailyRequests - MAP_GENERATION_USAGE_COST + 1; i++) {
      await usage.reserve({
        userId: "user-a",
        ...USAGE_KEYS,
        updatedAt: NOW.toISOString(),
        limits: { dailyRequests: 100, monthlyRequests: 1_000 },
      });
    }

    const res = await send("POST", "/learning-maps:generate", GOAL_REQUEST);

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "ai usage limit reached", limit: "daily" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await usedRequests()).toBe(
      AI_USAGE_LIMITS.dailyRequests - MAP_GENERATION_USAGE_COST + 1,
    );
  });

  it("マップが上限の数あれば、上流を叩かずに 409 を返す", async () => {
    for (let i = 0; i < MAX_MAPS_PER_USER; i++) {
      const created = await send("POST", "/learning-maps", { title: `マップ${String(i)}` });
      expect(created.status).toBe(201);
    }

    const res = await send("POST", "/learning-maps:generate", GOAL_REQUEST);

    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await usedRequests()).toBe(0);
  });

  it("同意が無ければ、送る前に 403 と今の版を返す", async () => {
    const res = await send("POST", "/learning-maps:generate", GOAL_WITHOUT_CONSENT);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "map generation consent required",
      version: MAP_GENERATION_CONSENT_VERSION,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("「今後表示しない」の記録があれば、その場の同意なしで作れる", async () => {
    await send("PUT", "/map-generation-consent", { version: MAP_GENERATION_CONSENT_VERSION });
    const res = await send("POST", "/learning-maps:generate", GOAL_WITHOUT_CONSENT);

    expect(res.status).toBe(201);
  });

  it("目標は目標までのマップでだけ受け取り、そこでは必須にする", async () => {
    const withoutGoal = {
      kind: "goal",
      theme: "Go",
      level: "basic",
      consentVersion: MAP_GENERATION_CONSENT_VERSION,
    };
    expect((await send("POST", "/learning-maps:generate", withoutGoal)).status).toBe(400);
    expect(
      (await send("POST", "/learning-maps:generate", { ...GOAL_REQUEST, kind: "field" })).status,
    ).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const field = await send("POST", "/learning-maps:generate", {
      ...withoutGoal,
      kind: "field",
      theme: "Kotlin",
    });
    expect(field.status).toBe(201);
    expect(promptOf(fetchMock.mock.calls[0]![1] as RequestInit)).toContain("分野の全体マップ");
  });
});

describe("/v1/map-generation-consent", () => {
  it("記録・確認・取り消しができ、古い版の同意は記録しない", async () => {
    const initial = (await (
      await send("GET", "/map-generation-consent")
    ).json()) as MapGenerationConsentBody;
    expect(initial).toEqual({ version: MAP_GENERATION_CONSENT_VERSION, granted: false });

    const outdated = await send("PUT", "/map-generation-consent", {
      version: MAP_GENERATION_CONSENT_VERSION - 1,
    });
    expect(outdated.status).toBe(409);

    const granted = await send("PUT", "/map-generation-consent", {
      version: MAP_GENERATION_CONSENT_VERSION,
    });
    expect(await granted.json()).toEqual({
      version: MAP_GENERATION_CONSENT_VERSION,
      granted: true,
      grantedAt: NOW.toISOString(),
    });

    const revoked = await send("DELETE", "/map-generation-consent");
    expect(await revoked.json()).toEqual({
      version: MAP_GENERATION_CONSENT_VERSION,
      granted: false,
    });
    expect(await consents.get("user-a")).toBeNull();
  });
});

describe("POST /v1/learning-maps/:id/checks:generate（#247）", () => {
  /** 確認問題も作る設定で、n ノードのマップを AI で作る。 */
  async function generatedMap(nodeCount: number, body: Record<string, unknown> = GOAL_REQUEST) {
    skeletonText = JSON.stringify({ title: "大きなマップ", nodes: ownNodes(nodeCount) });
    const res = await send("POST", "/learning-maps:generate", body);
    expect(res.status).toBe(201);
    fetchMock.mockClear();
    return ((await res.json()) as GenerateLearningMapResponse).map;
  }

  it("手前の 10 ノードの1項目目を、1回2組・5回で作り、作成時の組として保存する", async () => {
    const map = await generatedMap(25);
    expect(map.creationChecks).toEqual({ status: "pending" });

    const res = await send("POST", `/learning-maps/${map.id}/checks:generate`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as GenerateCreationChecksResponse;
    expect(body.failedCount).toBe(0);
    expect(body.skippedCount).toBe(0);
    const firstTen = map.nodes.slice(0, 10);
    expect(body.checks.map((check) => check.objectiveId)).toEqual(
      firstTen.map((node) => (node.kind === "own" ? node.objectives[0]!.id : undefined)),
    );
    expect(body.checks.every((check) => check.level === "basic")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // 本人の質問は載せない。
    expect(promptOf(fetchMock.mock.calls[0]![1] as RequestInit)).not.toContain(
      "自力で解決した質問",
    );
    expect(await checks.listMapCreationChecks("user-a")).toHaveLength(10);
    // マップの生成で 5 回、作成時の問題で 5 回。
    expect(await usedRequests()).toBe(MAP_GENERATION_USAGE_COST * 2);

    const after = (await (await send("GET", `/learning-maps/${map.id}`)).json()) as LearningMapView;
    expect(after.creationChecks).toEqual({ status: "done" });
    // 作成済みなら、もう頼めない。
    expect((await send("POST", `/learning-maps/${map.id}/checks:generate`)).status).toBe(409);
  });

  it("一部の組が作れなくても、作れた組は保存して作成済みにする", async () => {
    const map = await generatedMap(4);
    const firstNode = map.nodes[0]!.conceptId;
    // 1組目だけ選択肢が3つしかない。
    creationChecksFor = (conceptIds) =>
      JSON.stringify({
        checks: conceptIds.map((conceptId) =>
          conceptId === firstNode
            ? {
                ...generatedCheck(conceptId),
                overview: { ...generatedCheck(conceptId).overview, choices: ["a", "b", "c"] },
              }
            : generatedCheck(conceptId),
        ),
      });

    const res = await send("POST", `/learning-maps/${map.id}/checks:generate`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as GenerateCreationChecksResponse;
    expect(body.checks).toHaveLength(3);
    expect(body.failedCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("全部失敗したら、もう一度だけ頼める", async () => {
    const map = await generatedMap(4);
    fetchMock.mockImplementation(() => Promise.resolve(new Response("{}", { status: 400 })));

    const first = await send("POST", `/learning-maps/${map.id}/checks:generate`);
    expect(first.status).toBe(502);
    expect(await first.json()).toMatchObject({ error: "creation checks failed", retryable: true });

    const second = await send("POST", `/learning-maps/${map.id}/checks:generate`);
    expect(second.status).toBe(502);
    expect(await second.json()).toMatchObject({ retryable: false });

    const after = (await (await send("GET", `/learning-maps/${map.id}`)).json()) as LearningMapView;
    expect(after.creationChecks).toEqual({ status: "exhausted" });
    expect((await send("POST", `/learning-maps/${map.id}/checks:generate`)).status).toBe(409);
    expect(await checks.listMapCreationChecks("user-a")).toEqual([]);
  });

  it("確認問題を断ったマップと、手で作ったマップでは作れない", async () => {
    const declined = await generatedMap(3, { ...GOAL_REQUEST, checks: false });
    expect(declined.creationChecks).toBeUndefined();
    expect((await send("POST", `/learning-maps/${declined.id}/checks:generate`)).status).toBe(409);

    const manual = (await (await send("POST", "/learning-maps", { title: "手作り" })).json()) as {
      map: LearningMapView;
    };
    expect((await send("POST", `/learning-maps/${manual.map.id}/checks:generate`)).status).toBe(
      409,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await usedRequests()).toBe(MAP_GENERATION_USAGE_COST);
  });

  it("5 回分の枠が残っていなければ、上流を叩かず、頼んだ回数にも数えない", async () => {
    const map = await generatedMap(3);
    for (let i = 0; i < AI_USAGE_LIMITS.dailyRequests - MAP_GENERATION_USAGE_COST * 2 + 1; i++) {
      await usage.reserve({
        userId: "user-a",
        ...USAGE_KEYS,
        updatedAt: NOW.toISOString(),
        limits: { dailyRequests: 100, monthlyRequests: 1_000 },
      });
    }

    const res = await send("POST", `/learning-maps/${map.id}/checks:generate`);

    expect(res.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
    const after = (await (await send("GET", `/learning-maps/${map.id}`)).json()) as LearningMapView;
    expect(after.creationChecks).toEqual({ status: "pending" });
    // 頼んだ回数も戻っている（印も外れている）ので、まだ2回頼める。
    expect((await maps.get("user-a", map.id))?.creationChecks).toMatchObject({
      attempts: 0,
      startedAtMs: null,
    });
  });

  it("別の画面で作っている最中なら、回数を使わずに 409 を返す", async () => {
    const map = await generatedMap(3);
    // 別のタブが先に頼む権利を取った（まだ終わっていない）。
    await maps.claimCreationChecks("user-a", map.id, {
      maxAttempts: 2,
      nowMs: NOW.getTime(),
      leaseMs: 60_000,
    });

    const res = await send("POST", `/learning-maps/${map.id}/checks:generate`);

    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await usedRequests()).toBe(MAP_GENERATION_USAGE_COST);
  });

  it("上流へ送る前に例外が出たら、印を外し、頼んだ回数も戻す", async () => {
    const map = await generatedMap(3);
    vi.spyOn(usage, "reserve").mockRejectedValueOnce(new Error("d1 is down"));

    const res = await send("POST", `/learning-maps/${map.id}/checks:generate`);

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await maps.get("user-a", map.id))?.creationChecks).toMatchObject({
      attempts: 0,
      startedAtMs: null,
      doneAt: null,
    });
  });

  it("一部を保存したあとに例外が出たら、保存できた組を残して作成済みにする", async () => {
    const map = await generatedMap(4);
    const put = checks.put.bind(checks);
    let calls = 0;
    vi.spyOn(checks, "put").mockImplementation((...args) => {
      calls++;
      return calls === 1 ? put(...args) : Promise.reject(new Error("d1 is down"));
    });

    const res = await send("POST", `/learning-maps/${map.id}/checks:generate`);

    expect(res.status).toBe(500);
    expect(await checks.listMapCreationChecks("user-a")).toHaveLength(1);
    expect((await maps.get("user-a", map.id))?.creationChecks).toMatchObject({
      doneAt: NOW.toISOString(),
      startedAtMs: null,
    });
  });

  it("上流へ送ったあと、保存する前に例外が出たら、印だけ外す", async () => {
    const map = await generatedMap(2);
    vi.spyOn(usage, "addTokens").mockRejectedValue(new Error("d1 is down"));

    const res = await send("POST", `/learning-maps/${map.id}/checks:generate`);

    expect(res.status).toBe(500);
    expect((await maps.get("user-a", map.id))?.creationChecks).toMatchObject({
      attempts: 1,
      startedAtMs: null,
      doneAt: null,
    });
  });

  it("途中で止まった要求の印は、有効期間を過ぎたら無視して頼める", async () => {
    const map = await generatedMap(1);
    await maps.claimCreationChecks("user-a", map.id, {
      maxAttempts: 2,
      nowMs: NOW.getTime() - CREATION_CHECKS_LEASE_MS - 1,
      leaseMs: CREATION_CHECKS_LEASE_MS,
    });

    const res = await send("POST", `/learning-maps/${map.id}/checks:generate`);

    expect(res.status).toBe(200);
  });

  it("作成時の組を解くときに作り直すと、作成時の組ではなくなる", async () => {
    const map = await generatedMap(1);
    await send("POST", `/learning-maps/${map.id}/checks:generate`);
    const [created] = await checks.listMapCreationChecks("user-a");
    expect(created).toBeDefined();

    // 解くときの生成（`checks/generate.ts`）は origin を渡さずに上書きする。
    await checks.put("user-a", created!, NOW.getTime(), { mapId: map.id });

    expect(await checks.listMapCreationChecks("user-a")).toEqual([]);
  });
});
