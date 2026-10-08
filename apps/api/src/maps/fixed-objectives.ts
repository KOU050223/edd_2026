/**
 * `POST /v1/fixed-maps/:language/objectives:generate` の本体（Issue #245）。
 *
 * 固定の言語別マップの Concept の「理解すること」を AI で作り直し、今ある項目との差分を返す。
 * **保存しない。** 作成者が差分を確かめて手で直し、`PUT .../concepts/:conceptId/objectives` で確定する。
 *
 * - 今ある項目（ID と表示名）を AI に渡し、同じ内容には同じ ID を返させる。その Concept の今ある
 *   項目に無い ID が返ったら受理しない（決定 M5）。
 * - Concept を {@link FIXED_OBJECTIVES_CONCEPTS_PER_REQUEST} 個ずつ、入力の上限に収まる分だけ詰めて
 *   並列に頼む。回数は {@link usageCostOf} で決め、送る前にまとめて確保する。
 * - 送るのは運営が書いた Concept の定義と項目だけで、利用者の入力は入らないので同意は求めない。
 * - どれか1つでも失敗したら、案は返さない（一部の Concept だけの案で確定させない）。
 *
 * 作成者か・言語と Concept が正しいかはルート（`routes/fixed-maps.ts`）が確かめてから呼ぶ。
 */

import type { Concept } from "@gakushu-sochi/domain";
import {
  AI_USAGE_LIMITS,
  estimateInputTokens,
  planLimits,
  utcDayKey,
  utcMonthKey,
  type AiUsageLimitKind,
} from "../contract/ai-usage.js";
import type {
  FixedConceptObjectivesDraft,
  GenerateFixedObjectivesResponse,
} from "../contract/fixed-maps.js";
import { readGeneratedText } from "../checks/response.js";
import { upstreamFailureBody } from "../checks/errors.js";
import { requestCheckGeneration, UPSTREAM_RETRY_DELAYS_MS } from "../checks/upstream.js";
import type {
  IdentityRepository,
  LearningMapRepository,
  StoredLearningObjective,
} from "../repository/types.js";
import {
  limitReached,
  notConfiguredBody,
  resolveUpstreamConfig,
  type MapGenerationDeps,
} from "./generate.js";
import { buildFixedObjectivesPrompt, type FixedObjectiveTarget } from "./generation-prompt.js";
import { parseFixedObjectives, type FixedObjectiveCandidate } from "./generation-response.js";

/**
 * 1回で頼む Concept の数の上限。今ある項目も入出力に載るので、マップの生成（10）より少なくする。
 * 5 Concept × 5 項目に ID が付いても、出力の上限に収まる。
 */
export const FIXED_OBJECTIVES_CONCEPTS_PER_REQUEST = 5;
/** 1回の出力上限（マップの「理解すること」と同じ）。 */
export const FIXED_OBJECTIVES_MAX_OUTPUT_TOKENS = 4_096;

/** 作り直しが使う依存。マップの AI 生成と同じ設定・回数の記録を使う。 */
export type FixedObjectivesGenerationDeps = Pick<
  MapGenerationDeps,
  | "apiKey"
  | "model"
  | "models"
  | "fetch"
  | "usage"
  | "plans"
  | "enforceUsageLimits"
  | "retryDelaysMs"
  | "now"
>;

export interface GenerateFixedObjectivesDeps {
  generation: FixedObjectivesGenerationDeps;
  identity: IdentityRepository;
  maps: LearningMapRepository;
}

export type GenerateFixedObjectivesOutcome =
  | { status: 200; body: GenerateFixedObjectivesResponse }
  | { status: 429 | 500 | 502 | 503; body: object };

export async function generateFixedObjectives(
  deps: GenerateFixedObjectivesDeps,
  userId: string,
  language: string,
  /** 作り直す Concept（学ぶ順）。ルートがその言語の Concept であることを確かめている。 */
  concepts: readonly Concept[],
  /** 設定漏れのログに載せる。 */
  path: string,
): Promise<GenerateFixedObjectivesOutcome> {
  const { generation } = deps;
  const configured = resolveUpstreamConfig(generation, path);
  if (!configured.ok) return { status: 503, body: notConfiguredBody() };
  const { apiKey, models } = configured.value;

  const existing = groupByConcept(await deps.maps.listFixedObjectives());
  const targets: FixedObjectiveTarget[] = concepts.map((concept) => ({
    conceptId: concept.id,
    label: concept.label,
    // concepts.md の Concept は概要を必ず持つ（生成物の検査）。無ければ表示名だけで頼む。
    summary: concept.summary ?? concept.label,
    existing: (existing.get(concept.id) ?? []).map(({ id, label }) => ({ id, label })),
  }));
  const batches = planBatches(language, targets);
  if (batches === undefined) {
    console.error("a fixed concept does not fit the per-request input limit", { language });
    return { status: 500, body: { error: "fixed objectives prompt is too large" } };
  }

  const now = generation.now();
  const monthKey = utcMonthKey(now);
  const dayKey = utcDayKey(now);
  const cost = usageCostOf(batches);
  // `ai_usage.user_id` は `users(id)` を参照する。
  await deps.identity.ensureUser({ userId, nowMs: now.getTime() });
  const limits = planLimits(
    await generation.plans.get(userId),
    generation.enforceUsageLimits !== false,
  );
  const before = await generation.usage.get({ userId, monthKey, dayKey });
  if (before.monthlyTokens >= limits.monthlyTokens) {
    console.warn("ai usage token safety valve reached", { userId, monthKey });
    return { status: 429, body: limitReached("tokens", now, "fixed-objectives", cost) };
  }
  const { reserved, usage: after } = await generation.usage.reserve({
    userId,
    monthKey,
    dayKey,
    updatedAt: now.toISOString(),
    amount: cost,
    limits: { dailyRequests: limits.dailyRequests, monthlyRequests: limits.monthlyRequests },
  });
  if (!reserved) {
    const kind: AiUsageLimitKind =
      after.monthlyRequests + cost > limits.monthlyRequests ? "monthly" : "daily";
    return { status: 429, body: limitReached(kind, now, "fixed-objectives", cost) };
  }

  const results = await Promise.all(
    batches.map(async (batch, index): Promise<Step<Map<string, FixedObjectiveCandidate[]>>> => {
      const label = `fixed-objectives:${language}:${String(index + 1)}`;
      const upstream = await requestCheckGeneration({
        fetch: generation.fetch,
        apiKey,
        models,
        prompt: batch.prompt,
        maxOutputTokens: FIXED_OBJECTIVES_MAX_OUTPUT_TOKENS,
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
      // 本文が使えなくても課金は起きるので、判定より先に足す（取れなければ上界の見積もり。RULE-004）。
      await generation.usage.addTokens({
        userId,
        monthKey,
        dayKey,
        tokens:
          generated.totalTokens ??
          estimateInputTokens(batch.prompt) + FIXED_OBJECTIVES_MAX_OUTPUT_TOKENS,
        updatedAt: now.toISOString(),
      });
      if (!generated.ok) {
        console.error("fixed objectives response was not usable", {
          label,
          model: upstream.model,
          reason: generated.reason,
          detail: generated.detail,
        });
        return { ok: false, outcome: { status: 502, body: failureBody(generated.finishReason) } };
      }
      const parsed = parseFixedObjectives(
        generated.text,
        new Map(
          batch.targets.map((target) => [
            target.conceptId,
            new Set(target.existing.map((objective) => objective.id)),
          ]),
        ),
      );
      if (!parsed.ok) {
        console.error("fixed objectives were rejected", {
          label,
          reason: parsed.reason,
          detail: parsed.detail,
        });
        return { ok: false, outcome: { status: 502, body: failureBody() } };
      }
      return { ok: true, value: parsed.value };
    }),
  );

  const generatedByConcept = new Map<string, FixedObjectiveCandidate[]>();
  for (const result of results) {
    if (!result.ok) return result.outcome;
    for (const [conceptId, objectives] of result.value) {
      generatedByConcept.set(conceptId, objectives);
    }
  }
  console.info("fixed objectives generation completed", {
    language,
    conceptCount: targets.length,
    calls: cost,
  });
  return {
    status: 200,
    body: {
      concepts: targets.map((target) =>
        toDraft(target, generatedByConcept.get(target.conceptId) ?? []),
      ),
    },
  };
}

type Step<T> = { ok: true; value: T } | { ok: false; outcome: { status: 502; body: object } };

/** 今ある項目と AI の案を突き合わせて、引き継ぐ・新しく作る・消えるに分ける。 */
function toDraft(
  target: FixedObjectiveTarget,
  generated: readonly FixedObjectiveCandidate[],
): FixedConceptObjectivesDraft {
  const previous = new Map(target.existing.map((objective) => [objective.id, objective.label]));
  const kept = new Set<string>();
  const objectives = generated.map((objective) => {
    if (objective.id === undefined) return { kind: "new" as const, label: objective.label };
    kept.add(objective.id);
    return {
      kind: "kept" as const,
      id: objective.id,
      label: objective.label,
      // 受理（parseFixedObjectives）で、今ある項目の ID だけを通している。
      previousLabel: previous.get(objective.id)!,
    };
  });
  return {
    conceptId: target.conceptId,
    objectives,
    removed: target.existing.filter((objective) => !kept.has(objective.id)),
  };
}

/**
 * 確保する回数。1回の上界（入力 6,000 + 出力 2,048、docs/ai-limits.md）で、全呼び出しの
 * （入力の見積もり + 出力上限）を割って切り上げる。出力上限を 4,096 に広げた分が、月のトークン量の
 * 安全弁の前提（1回 8,048 まで）を崩さないようにするため。ふつうは呼び出しの数と同じになる。
 */
export function usageCostOf(batches: readonly { prompt: string }[]): number {
  const worstCase = batches.reduce(
    (sum, batch) => sum + estimateInputTokens(batch.prompt) + FIXED_OBJECTIVES_MAX_OUTPUT_TOKENS,
    0,
  );
  return Math.max(
    batches.length,
    Math.ceil(
      worstCase / (AI_USAGE_LIMITS.inputTokensPerRequest + AI_USAGE_LIMITS.outputTokensPerRequest),
    ),
  );
}

interface Batch {
  targets: FixedObjectiveTarget[];
  prompt: string;
}

/**
 * 学ぶ順に、{@link FIXED_OBJECTIVES_CONCEPTS_PER_REQUEST} 個ずつ、入力に収まる分だけ詰める。
 *
 * @returns 1つの Concept だけでも入力に収まらなければ `undefined`。
 */
function planBatches(
  language: string,
  targets: readonly FixedObjectiveTarget[],
): Batch[] | undefined {
  const batches: Batch[] = [];
  let pending: FixedObjectiveTarget[] = [];
  const promptFor = (items: readonly FixedObjectiveTarget[]) =>
    buildFixedObjectivesPrompt(language, items);
  const fits = (items: readonly FixedObjectiveTarget[]) =>
    estimateInputTokens(promptFor(items)) <= AI_USAGE_LIMITS.inputTokensPerRequest;

  for (const target of targets) {
    const next = [...pending, target];
    if (next.length <= FIXED_OBJECTIVES_CONCEPTS_PER_REQUEST && fits(next)) {
      pending = next;
      continue;
    }
    if (pending.length > 0) batches.push({ targets: pending, prompt: promptFor(pending) });
    if (!fits([target])) return undefined;
    pending = [target];
  }
  if (pending.length > 0) batches.push({ targets: pending, prompt: promptFor(pending) });
  return batches;
}

function groupByConcept(
  objectives: readonly StoredLearningObjective[],
): Map<string, StoredLearningObjective[]> {
  const grouped = new Map<string, StoredLearningObjective[]>();
  for (const objective of objectives) {
    grouped.set(objective.conceptId, [...(grouped.get(objective.conceptId) ?? []), objective]);
  }
  return grouped;
}

function failureBody(finishReason?: string) {
  const message =
    "AI が作った「理解すること」を受け取れませんでした。何も保存していません。もう一度お試しください。";
  return {
    error: "fixed objectives generation failed" as const,
    message: finishReason === undefined ? message : `${message}（AI の終了理由: ${finishReason}）`,
    ...(finishReason === undefined ? {} : { finishReason }),
  };
}
