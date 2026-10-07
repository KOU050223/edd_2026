/**
 * `POST /v1/learning-maps:generate` の本体（Issue #243 / Web/19）。テーマ・目標から AI で
 * 学習マップを作り、各ノードの「理解すること」も一緒に作って保存する。
 *
 * ルート（`routes/learning-maps.ts`）は検証済みの入力を渡し、返った状態コードと本文を返す。
 * ここは Hono に依存しない。流れは次の順で、5 までのどこで止まっても上流へは送らない。
 *
 * 1. 生成の同意を確かめる
 * 2. 設定（API キー、モデルの allowlist）を確かめる
 * 3. マップの数が上限に達していないかを確かめる
 * 4. 骨組みのプロンプトを組む（既存の Concept と本人の理解度は入力上限に収める）
 * 5. 回数を 5 回分まとめて確保する（内部で何回呼ぶかにかかわらない。#243 の決定 2）
 * 6. 骨組みを作る → ノードを数個ずつに分けて「理解すること」を並列で作る
 * 7. マップ・ノード・線・項目を1つの操作で保存する
 *
 * **6 のどこかで失敗したら何も保存しない。** 項目の無いノードや途中までのマップを残さない
 * （#243 の決定、設計/06 #234）。上流へ送ったあとの失敗では、確保した回数は戻さない
 * （確認問題と同じ。上流では課金されている）。
 */

import {
  MAP_GENERATION_CONSENT_VERSION,
  deriveMasteryFromEvents,
  type Concept,
  type LearningObjective,
  type MasteryStatus,
} from "@gakushu-sochi/domain";
import {
  AI_USAGE_LIMITS,
  ALLOWED_MODELS,
  estimateInputTokens,
  isAllowedModel,
  nextUtcDay,
  nextUtcMonth,
  utcDayKey,
  utcMonthKey,
  type AiUsageLimitBody,
  type AiUsageLimitKind,
  type AllowedModel,
} from "../contract/ai-usage.js";
import {
  MAP_GENERATION_USAGE_COST,
  MAX_CLIENT_CONCEPTS,
  MAX_MAPS_PER_USER,
  type GenerateLearningMapInput,
  type LearningMapContentInput,
} from "../contract/learning-maps.js";
import { readGeneratedText, type GeneratedTextFailure } from "../checks/response.js";
import { upstreamFailureBody } from "../checks/errors.js";
import { requestCheckGeneration, UPSTREAM_RETRY_DELAYS_MS } from "../checks/upstream.js";
import type {
  AiUsageRepository,
  CheckGenerationConsentRepository,
  IdentityRepository,
  LearningEventRepository,
  LearningMapRepository,
  MasteryOverrideRepository,
  StoredLearningObjective,
} from "../repository/types.js";
import { loadUserConceptCatalog } from "./catalog.js";
import { newMapId, resolveMapContent } from "./content.js";
import {
  buildObjectivesPrompt,
  buildSkeletonPrompt,
  type MapGenerationRequest,
  type ObjectiveTargetNode,
  type ReferenceCandidate,
  type SkeletonPromptInput,
} from "./generation-prompt.js";
import {
  parseObjectives,
  parseSkeleton,
  type GeneratedSkeleton,
  type MapParseFailure,
} from "./generation-response.js";

/** 骨組みの1回の出力上限（#243 の 2026-10-08 の決定）。30 ノードの表示名と概要が収まる量。 */
export const SKELETON_MAX_OUTPUT_TOKENS = 8_192;
/** 「理解すること」の1回の出力上限。10 ノード × 5 項目が収まる量。 */
export const OBJECTIVES_MAX_OUTPUT_TOKENS = 4_096;
/** 「理解すること」を1回で頼むノードの数の上限。入力に収まらなければこれより減らす。 */
export const OBJECTIVES_NODES_PER_REQUEST = 10;
/**
 * 1マップの生成で使ってよいトークンの合計。数える回数（5 回）の1回あたりの上界
 * （入力 6,000 + 出力 2,048）の 5 倍。月のトークン量の安全弁の前提を崩さないため（決定 J1）。
 */
export const MAP_GENERATION_TOKEN_BUDGET =
  MAP_GENERATION_USAGE_COST *
  (AI_USAGE_LIMITS.inputTokensPerRequest + AI_USAGE_LIMITS.outputTokensPerRequest);

/** マップの AI 生成だけが使う依存。`routes/learning-maps.ts` の依存に載せる。 */
export interface MapGenerationDeps {
  apiKey?: string;
  model?: string;
  /** 順に試すモデル（確認問題と同じ `vars.CHECK_MODELS`）。省略・空なら {@link model} だけ。 */
  models?: readonly string[];
  fetch: typeof fetch;
  usage: AiUsageRepository;
  /** 「今後表示しない」の記録（migrations/0014_map_generation_consents.sql）。 */
  consents: CheckGenerationConsentRepository;
  /** 本人の理解度を導出するために読む。 */
  events: LearningEventRepository;
  overrides: MasteryOverrideRepository;
  /** 回数上限を効かせるか。省略は効かせる（確認問題の `CHECK_GENERATION_LIMITS` と同じ）。 */
  enforceUsageLimits?: boolean;
  /** 上流の一時的な失敗のあとの待ち時間。省略は `UPSTREAM_RETRY_DELAYS_MS`。テストで縮める。 */
  retryDelaysMs?: readonly number[];
  now: () => Date;
}

/** 生成が使う依存の全体。マップの保存先と ID の振り方は手で作るマップと共有する。 */
export interface GenerateLearningMapDeps {
  generation: MapGenerationDeps;
  identity: IdentityRepository;
  maps: LearningMapRepository;
  fixedConcepts: readonly Concept[];
  fixedObjectives: readonly LearningObjective[];
  newKey: () => string;
}

/** ルートがそのまま返す状態コードと本文。成功なら保存したマップの ID。 */
export type GenerateLearningMapOutcome =
  { status: 201; mapId: string } | { status: 403 | 409 | 429 | 500 | 502 | 503; body: object };

type Step<T> = { ok: true; value: T } | { ok: false; outcome: GenerateLearningMapOutcome };

export async function generateLearningMap(
  deps: GenerateLearningMapDeps,
  userId: string,
  input: GenerateLearningMapInput,
  /** 設定漏れのログに載せる。 */
  path: string,
): Promise<GenerateLearningMapOutcome> {
  const generation = deps.generation;
  const request: MapGenerationRequest = {
    kind: input.kind,
    theme: input.theme,
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    level: input.level,
  };

  const consent = await checkConsent(generation, userId, input.consentVersion);
  if (!consent.ok) return consent.outcome;

  const configured = resolveUpstreamConfig(generation, path);
  if (!configured.ok) return configured.outcome;
  const { apiKey, models } = configured.value;

  // 上限に達しているなら、上流を叩く前に止める（決定 J7）。保存のときにも同じ判定を1つの操作で行う。
  if ((await deps.maps.listByOwner(userId)).length >= MAX_MAPS_PER_USER) {
    return { status: 409, body: mapLimitBody() };
  }

  const skeletonInput = await loadSkeletonInput(deps, userId, request);
  const skeletonPrompt = fitSkeletonPrompt(skeletonInput);
  if (skeletonPrompt === undefined) {
    // 候補を全部落としても収まらない。テーマと目標の上限から見て起きないはずで、方針の文面の見積もり違い。
    console.error("map skeleton prompt exceeds the per-request input limit", {
      limit: AI_USAGE_LIMITS.inputTokensPerRequest,
    });
    return { status: 500, body: { error: "map generation prompt is too large" } };
  }
  const candidateIds = new Set(skeletonPrompt.candidates.map((candidate) => candidate.id));

  const now = generation.now();
  const reserved = await reserveUsage(generation, deps.identity, userId, now);
  if (!reserved.ok) return reserved.outcome;
  const { monthKey, dayKey } = reserved.value;

  /** 上流へ1回送り、実消費を足して本文を返す。本文が使えなくても課金は起きるので先に足す。 */
  const call = async (
    label: string,
    prompt: string,
    maxOutputTokens: number,
  ): Promise<Step<{ text: string; tokens: number }>> => {
    const upstream = await requestCheckGeneration({
      fetch: generation.fetch,
      apiKey,
      models,
      prompt,
      maxOutputTokens,
      retryDelaysMs: generation.retryDelaysMs ?? UPSTREAM_RETRY_DELAYS_MS,
      conceptId: label,
    });
    if (!upstream.ok) {
      return {
        ok: false,
        outcome: {
          status: 502,
          body: upstreamFailureBody(upstream.reason, upstream.trace, upstream.status),
        },
      };
    }
    const generated = readGeneratedText(upstream.raw);
    // 取れなければ 0 で済ませず、上界の見積もりを足して残す（RULE-004）。
    const tokens = generated.totalTokens ?? estimateInputTokens(prompt) + maxOutputTokens;
    if (generated.totalTokens === undefined) {
      console.warn("map generation did not report token usage; adding an estimate", {
        label,
        model: upstream.model,
        tokens,
      });
    }
    await generation.usage.addTokens({
      userId,
      monthKey,
      dayKey,
      tokens,
      updatedAt: now.toISOString(),
    });
    if (!generated.ok) {
      console.error("map generation response was not usable", {
        label,
        model: upstream.model,
        reason: generated.reason,
        detail: generated.detail,
      });
      return {
        ok: false,
        outcome: { status: 502, body: failureBody(generated.reason, generated.finishReason) },
      };
    }
    return { ok: true, value: { text: generated.text, tokens } };
  };

  // 骨組み
  const skeletonCall = await call(
    "map:skeleton",
    buildSkeletonPrompt(skeletonPrompt),
    SKELETON_MAX_OUTPUT_TOKENS,
  );
  if (!skeletonCall.ok) return skeletonCall.outcome;
  const parsedSkeleton = parseSkeleton(skeletonCall.value.text, candidateIds);
  if (!parsedSkeleton.ok) return rejected("map:skeleton", parsedSkeleton);
  const skeleton = parsedSkeleton.value;

  // 「理解すること」
  const batches = planObjectiveBatches(request, skeleton);
  if (batches === undefined) {
    console.error("a single map node does not fit the per-request input limit");
    return { status: 500, body: { error: "map generation prompt is too large" } };
  }
  // 残りの呼び出しを上限いっぱいまで使っても、5 回分の上界に収まるときだけ進める（決定 J1）。
  const worstCase =
    skeletonCall.value.tokens +
    batches.reduce(
      (sum, batch) => sum + estimateInputTokens(batch.prompt) + OBJECTIVES_MAX_OUTPUT_TOKENS,
      0,
    );
  if (worstCase > MAP_GENERATION_TOKEN_BUDGET) {
    console.error("map generation would exceed its token budget", {
      skeletonTokens: skeletonCall.value.tokens,
      batches: batches.length,
      worstCase,
      budget: MAP_GENERATION_TOKEN_BUDGET,
    });
    return { status: 502, body: failureBody("too-large") };
  }
  const objectiveCalls = await Promise.all(
    batches.map((batch, index) =>
      call(`map:objectives:${String(index + 1)}`, batch.prompt, OBJECTIVES_MAX_OUTPUT_TOKENS),
    ),
  );
  const objectivesByKey = new Map<string, string[]>();
  for (const [index, result] of objectiveCalls.entries()) {
    if (!result.ok) return result.outcome;
    const batch = batches[index]!;
    const parsed = parseObjectives(
      result.value.text,
      batch.nodes.map((node) => node.key),
    );
    if (!parsed.ok) return rejected(`map:objectives:${String(index + 1)}`, parsed);
    for (const [key, labels] of parsed.value) objectivesByKey.set(key, labels);
  }

  return save(deps, userId, skeleton, objectivesByKey, now, request);
}

/** 骨組みのプロンプトの材料（参照の候補と、本人が学んでいる Concept）を読む。 */
async function loadSkeletonInput(
  deps: GenerateLearningMapDeps,
  userId: string,
  request: MapGenerationRequest,
): Promise<SkeletonPromptInput> {
  const [catalog, events, overrides] = await Promise.all([
    loadUserConceptCatalog(deps.maps, userId, {
      concepts: deps.fixedConcepts,
      objectives: deps.fixedObjectives,
    }),
    deps.generation.events.listByUser(userId),
    deps.generation.overrides.listByUser(userId),
  ]);

  // 理解度は `GET /v1/learning-profile` と同じ規則で導出し、本人の手動の上書きを重ねる
  // （`routes/ai.ts` の学習の現在地と同じ扱い）。
  const statuses = new Map<string, MasteryStatus>();
  for (const item of Object.values(deriveMasteryFromEvents(events, catalog.objectives))) {
    if (item !== undefined) statuses.set(item.conceptId, item.status);
  }
  for (const [conceptId, override] of Object.entries(overrides)) {
    statuses.set(conceptId, override.status);
  }

  // 参照で置けるのは「理解すること」を持つ Concept だけ（決定 J4）。固定の Concept が先、
  // 手で作ったノードは更新の新しいマップから {@link MAX_CLIENT_CONCEPTS} 件まで（決定 J5）。
  const withObjectives = new Set(catalog.objectives.map((objective) => objective.conceptId));
  const fixedIds = new Set(deps.fixedConcepts.map((concept) => concept.id));
  const toCandidate = (concept: Concept): ReferenceCandidate => ({
    id: concept.id,
    label: concept.label,
    status: statuses.get(concept.id) ?? "unobserved",
  });
  const candidates = [
    ...catalog.concepts
      .filter((concept) => fixedIds.has(concept.id) && withObjectives.has(concept.id))
      .map(toCandidate),
    ...catalog.concepts
      .filter((concept) => !fixedIds.has(concept.id) && withObjectives.has(concept.id))
      .slice(0, MAX_CLIENT_CONCEPTS)
      .map(toCandidate),
  ];
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const knownLabels = catalog.concepts.flatMap((concept) => {
    const status = statuses.get(concept.id);
    if (candidateIds.has(concept.id) || status === undefined || status === "unobserved") return [];
    return [{ label: concept.label, status }];
  });
  return { request, candidates, knownLabels };
}

/**
 * 入力の上限に収まるまで、材料を後ろ（古いもの）から落とす。手で作ったノードの候補、
 * 学んでいる Concept の表示名、固定の Concept の候補の順に落とす（決定 J5）。
 *
 * @returns 収まった材料。全部落としても収まらなければ `undefined`。
 */
function fitSkeletonPrompt(input: SkeletonPromptInput): SkeletonPromptInput | undefined {
  const fixed = input.candidates.filter((candidate) => !isOwnNodeId(candidate.id));
  const own = input.candidates.filter((candidate) => isOwnNodeId(candidate.id));
  const known = [...input.knownLabels];
  const current = (): SkeletonPromptInput => ({
    request: input.request,
    candidates: [...fixed, ...own],
    knownLabels: known,
  });
  const fits = () =>
    estimateInputTokens(buildSkeletonPrompt(current())) <= AI_USAGE_LIMITS.inputTokensPerRequest;
  while (!fits()) {
    if (own.pop() !== undefined) continue;
    if (known.pop() !== undefined) continue;
    if (fixed.pop() !== undefined) continue;
    return undefined;
  }
  if (
    own.length + known.length + fixed.length <
    input.candidates.length + input.knownLabels.length
  ) {
    console.info("map generation dropped existing concepts to fit the input limit", {
      candidates: input.candidates.length,
      kept: fixed.length + own.length,
      knownLabels: input.knownLabels.length,
      keptKnownLabels: known.length,
    });
  }
  return current();
}

/** 手で作ったノードの ID（`m` + 8 文字のマップ ID で始まる）か。固定の Concept は言語名で始まる。 */
function isOwnNodeId(conceptId: string): boolean {
  return /^m[a-z0-9]{8}\./.test(conceptId);
}

/** 「理解すること」を頼む1回分。 */
interface ObjectiveBatch {
  nodes: ObjectiveTargetNode[];
  prompt: string;
}

/**
 * 新しいノードを学ぶ順に、{@link OBJECTIVES_NODES_PER_REQUEST} 個ずつ、入力に収まる分だけ詰める。
 *
 * @returns 1ノードだけでも入力に収まらなければ `undefined`。
 */
function planObjectiveBatches(
  request: MapGenerationRequest,
  skeleton: GeneratedSkeleton,
): ObjectiveBatch[] | undefined {
  const batches: ObjectiveBatch[] = [];
  let pending: ObjectiveTargetNode[] = [];
  const promptFor = (nodes: readonly ObjectiveTargetNode[]) =>
    buildObjectivesPrompt(request, skeleton.title, nodes);
  const fits = (nodes: readonly ObjectiveTargetNode[]) =>
    estimateInputTokens(promptFor(nodes)) <= AI_USAGE_LIMITS.inputTokensPerRequest;

  for (const node of skeleton.nodes) {
    if (node.kind !== "own") continue;
    const target = { key: node.key, label: node.label, summary: node.summary };
    const next = [...pending, target];
    if (next.length <= OBJECTIVES_NODES_PER_REQUEST && fits(next)) {
      pending = next;
      continue;
    }
    if (pending.length > 0) batches.push({ nodes: pending, prompt: promptFor(pending) });
    if (!fits([target])) return undefined;
    pending = [target];
  }
  if (pending.length > 0) batches.push({ nodes: pending, prompt: promptFor(pending) });
  return batches;
}

/** 骨組みと項目を保存する形にして、1つの操作で書く。 */
async function save(
  deps: GenerateLearningMapDeps,
  userId: string,
  skeleton: GeneratedSkeleton,
  objectivesByKey: ReadonlyMap<string, readonly string[]>,
  now: Date,
  request: MapGenerationRequest,
): Promise<GenerateLearningMapOutcome> {
  const refOf = new Map(
    skeleton.nodes.map((node) => [
      node.key,
      node.kind === "own" ? `new:${node.key}` : node.conceptId,
    ]),
  );
  const content: LearningMapContentInput = {
    title: skeleton.title,
    description: skeleton.description,
    nodes: skeleton.nodes.map((node) =>
      node.kind === "own"
        ? { kind: "own", ref: `new:${node.key}`, label: node.label, summary: node.summary }
        : { kind: "reference", conceptId: node.conceptId },
    ),
    edges: skeleton.nodes.flatMap((node) =>
      node.prerequisite === undefined
        ? []
        : [{ from: refOf.get(node.prerequisite)!, to: refOf.get(node.key)! }],
    ),
  };
  const mapId = newMapId(deps.newKey);
  const resolved = resolveMapContent(mapId, content, new Set(), deps.newKey);
  if (!resolved.ok) {
    // 応答の検証（`parseSkeleton`）を通った骨組みが手作りの規則で拒否されるなら、2つの規則が食い違っている。
    console.error("generated map was rejected by the map rules", { reason: resolved.error });
    return { status: 502, body: failureBody("structure") };
  }

  // 生成の間に、参照した自分のマップのノードが消されていたら保存しない。
  // 残すと元の無い参照（項目の無いノード）ができる。
  const ownReferences = resolved.referenceIds.filter(isOwnNodeId);
  const found = await deps.maps.findOwnNodes(userId, ownReferences);
  if (found.length !== ownReferences.length) {
    console.info("generated map was discarded because a referenced node was removed");
    return {
      status: 409,
      body: {
        error: "map discarded by reference change",
        message:
          "生成中に、マップに入れた既存のノードが削除されたため、作ったマップは保存しませんでした。もう一度お試しください。",
      },
    };
  }

  const objectives: StoredLearningObjective[] = [];
  for (const node of skeleton.nodes) {
    if (node.kind !== "own") continue;
    const conceptId = resolved.assigned[`new:${node.key}`]!;
    const used = new Set<string>();
    for (const label of objectivesByKey.get(node.key) ?? []) {
      objectives.push({
        id: newObjectiveId(deps.newKey, conceptId, used),
        conceptId,
        label,
        source: "ai",
      });
    }
  }

  const nowIso = now.toISOString();
  const { created } = await deps.maps.create(userId, {
    id: mapId,
    content: resolved.content,
    objectives,
    nowIso,
    nowMs: now.getTime(),
    maxMaps: MAX_MAPS_PER_USER,
  });
  if (!created) {
    // 生成の間に、別の端末でマップが作られて上限に達した。
    return { status: 409, body: mapLimitBody() };
  }
  console.info("map generation completed", {
    mapId,
    kind: request.kind,
    level: request.level,
    nodeCount: resolved.content.nodes.length,
    objectiveCount: objectives.length,
  });
  return { status: 201, mapId };
}

/** `<Concept ID>:<識別子>`。同じノードの中で重ならないものを引く（`routes/learning-maps.ts` と同じ形）。 */
function newObjectiveId(newKey: () => string, conceptId: string, used: Set<string>): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = `${conceptId}:${newKey()}`;
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new Error("could not assign a unique objective id");
}

function rejected(
  label: string,
  result: { reason: MapParseFailure; detail?: string },
): GenerateLearningMapOutcome {
  console.error("generated map was rejected", {
    label,
    reason: result.reason,
    detail: result.detail,
  });
  return { status: 502, body: failureBody(result.reason) };
}

/** 送る前に同意を確かめる。その場の同意か、「今後表示しない」の記録のどちらか。 */
async function checkConsent(
  generation: MapGenerationDeps,
  userId: string,
  consentVersion: number | undefined,
): Promise<Step<undefined>> {
  if (consentVersion === MAP_GENERATION_CONSENT_VERSION) return { ok: true, value: undefined };
  const stored = await generation.consents.get(userId);
  if (stored?.version === MAP_GENERATION_CONSENT_VERSION) return { ok: true, value: undefined };
  return {
    ok: false,
    outcome: {
      status: 403,
      body: {
        error: "map generation consent required",
        message: "マップを作る前に、AI へ送る内容を確認して同意してください。",
        version: MAP_GENERATION_CONSENT_VERSION,
      },
    },
  };
}

/** API キーと、送ってよいモデルの並びを確かめる（`checks/generate.ts` と同じ規則）。 */
function resolveUpstreamConfig(
  generation: MapGenerationDeps,
  path: string,
): Step<{ apiKey: string; models: AllowedModel[] }> {
  if (!generation.apiKey) {
    console.error("ai service is not configured", { path });
    return { ok: false, outcome: { status: 503, body: notConfiguredBody() } };
  }
  const configured =
    generation.models !== undefined && generation.models.length > 0
      ? generation.models
      : [generation.model ?? ALLOWED_MODELS[0]];
  const models = configured.filter(isAllowedModel);
  if (models.length !== configured.length) {
    console.error("configured model is not allowed", {
      models: configured,
      allowed: ALLOWED_MODELS,
    });
    return { ok: false, outcome: { status: 503, body: notConfiguredBody() } };
  }
  return { ok: true, value: { apiKey: generation.apiKey, models } };
}

/** 5 回分をまとめて確保する。上流へ送る前に行う（`checks/generate.ts` と同じ理由）。 */
async function reserveUsage(
  generation: MapGenerationDeps,
  identity: IdentityRepository,
  userId: string,
  now: Date,
): Promise<Step<{ monthKey: string; dayKey: string }>> {
  const monthKey = utcMonthKey(now);
  const dayKey = utcDayKey(now);
  // `ai_usage.user_id` は `users(id)` を参照する。
  await identity.ensureUser({ userId, nowMs: now.getTime() });

  const before = await generation.usage.get({ userId, monthKey, dayKey });
  if (before.monthlyTokens >= AI_USAGE_LIMITS.monthlyTokens) {
    console.warn("ai usage token safety valve reached", {
      userId,
      monthKey,
      monthlyTokens: before.monthlyTokens,
      limit: AI_USAGE_LIMITS.monthlyTokens,
    });
    return { ok: false, outcome: { status: 429, body: limitReached("tokens", now) } };
  }
  const { reserved, usage: after } = await generation.usage.reserve({
    userId,
    monthKey,
    dayKey,
    updatedAt: now.toISOString(),
    amount: MAP_GENERATION_USAGE_COST,
    limits:
      generation.enforceUsageLimits === false
        ? { dailyRequests: Number.MAX_SAFE_INTEGER, monthlyRequests: Number.MAX_SAFE_INTEGER }
        : {
            dailyRequests: AI_USAGE_LIMITS.dailyRequests,
            monthlyRequests: AI_USAGE_LIMITS.monthlyRequests,
          },
  });
  if (!reserved) {
    const kind: AiUsageLimitKind =
      after.monthlyRequests + MAP_GENERATION_USAGE_COST > AI_USAGE_LIMITS.monthlyRequests
        ? "monthly"
        : "daily";
    return { ok: false, outcome: { status: 429, body: limitReached(kind, now) } };
  }
  return { ok: true, value: { monthKey, dayKey } };
}

/** 生成に失敗したことを利用者へ伝える本文。**途中までのマップは保存していない。** */
export interface MapGenerationErrorBody {
  error: "map generation failed";
  reason: GeneratedTextFailure | MapParseFailure | "too-large";
  message: string;
  finishReason?: string;
}

function failureBody(
  reason: MapGenerationErrorBody["reason"],
  finishReason?: string,
): MapGenerationErrorBody {
  const message = {
    "not-json": "AI の応答をマップとして読めませんでした。",
    blocked: "AI が生成を拒否しました。テーマや目標の書き方を変えてお試しください。",
    "no-text": "AI がマップを返しませんでした。",
    truncated: "AI の応答が途中で切れました。",
    shape:
      "AI が作ったマップが形式（題名・ノードの表示名と概要・ノード数）を満たしていませんでした。",
    structure: "AI が作ったマップが木の形（前提は1つまで・循環なし）になっていませんでした。",
    "unknown-reference": "AI が、存在しない既存の概念をマップに入れようとしました。",
    objectives: "AI が作った「理解すること」が、ノードと合っていませんでした。",
    "too-large": "AI が作ったマップが大きすぎて、「理解すること」を作れませんでした。",
  }[reason];
  const suffix = "途中までのマップは保存していません。もう一度お試しください。";
  if (finishReason === undefined) {
    return { error: "map generation failed", reason, message: `${message}${suffix}` };
  }
  return {
    error: "map generation failed",
    reason,
    message: `${message}${suffix}（AI の終了理由: ${finishReason}）`,
    finishReason,
  };
}

function mapLimitBody() {
  return {
    error: "learning_map_limit_reached",
    message: `マップは ${String(MAX_MAPS_PER_USER)} 個まで作れます。使わないマップを削除してからお試しください。`,
  };
}

function notConfiguredBody() {
  return {
    error: "AI service is not configured" as const,
    message:
      "AI の設定に問題があるため、マップを作れません。時間をおいても直らない場合は運営に連絡してください。",
  };
}

/** 上限到達時の応答。形は `POST /v1/ai/responses` と同じ（`AiUsageLimitBody`）。 */
function limitReached(kind: AiUsageLimitKind, now: Date): AiUsageLimitBody {
  const resetAt = kind === "daily" ? nextUtcDay(now) : nextUtcMonth(now);
  const when = kind === "daily" ? "明日 UTC 0時" : "翌月 UTC 1日 0時";
  const scope = kind === "daily" ? "今日" : "今月";
  return {
    error: "ai usage limit reached",
    limit: kind,
    resetAt: resetAt.toISOString(),
    message:
      `マップを1つ作るには AI の利用回数を ${String(MAP_GENERATION_USAGE_COST)} 回使いますが、` +
      `${scope}の残りが足りません。${when}に回復します。手でマップを作るのは回数を使いません。`,
  };
}
