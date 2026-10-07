/**
 * `POST /v1/learning-maps/:id/checks:generate` の本体（Issue #247）。AI で作ったマップに、
 * マップの定義だけから確認問題を作る。ここで作った組だけが共有の側へ上げられる。
 *
 * 対象は AI で作るときに「確認問題も作る」を選んだマップだけ（#247 の 2026-10-08 の決定）。
 * Web はマップを作って保存したあと、続けてこの口を呼ぶ（決定 K1）。
 *
 * - 学習の順で手前のノード（参照のノードは除く）から、各ノードの「理解すること」の1項目目を狙い、
 *   最大 {@link MAX_CREATION_CHECKS} 組を作る（決定 L3）。
 * - 1回の呼び出しで {@link CHECKS_PER_REQUEST} 組。回数は呼び出しの数にかかわらず固定 5 回（決定 K2）。
 * - 一部の呼び出しが失敗しても、作れた組は保存する。全部失敗したら、もう一度だけ頼める（決定 L4）。
 * - 本人の質問は送らない。同意はマップを作るときの同意に含まれる（決定 K3）。
 */

import type { CheckLevel, PersonalConceptCheck } from "@gakushu-sochi/domain";
import {
  AI_USAGE_LIMITS,
  estimateInputTokens,
  utcDayKey,
  utcMonthKey,
  type AiUsageLimitKind,
} from "../contract/ai-usage.js";
import { MAP_GENERATION_USAGE_COST } from "../contract/learning-maps.js";
import {
  checkPromptInputFor,
  buildCreationChecksPrompt,
  type CreationCheckTarget,
} from "../checks/prompt.js";
import { parseCreationChecks, readGeneratedText } from "../checks/response.js";
import { requestCheckGeneration, UPSTREAM_RETRY_DELAYS_MS } from "../checks/upstream.js";
import { loadUserConceptCatalog } from "./catalog.js";
import {
  MAP_GENERATION_TOKEN_BUDGET,
  limitReached,
  notConfiguredBody,
  resolveUpstreamConfig,
  type GenerateLearningMapDeps,
} from "./generate.js";

/** マップを作るときに作る組の最大数（#237 の決定 C1）。 */
export const MAX_CREATION_CHECKS = 10;
/** 1回の呼び出しで作る組の数（#247 の決定 K2）。 */
export const CHECKS_PER_REQUEST = 2;
/** 1回の出力上限。1組なら 2,048 で足りるが、2組を1回で返させるので広げる。 */
export const CREATION_CHECKS_MAX_OUTPUT_TOKENS = 4_096;
/** 頼める回数。全部失敗したときに、もう一度だけ頼める（決定 L4）。 */
export const MAX_CREATION_CHECK_ATTEMPTS = 2;
/** 作成時の問題で `ai_usage` から引く回数（マップの生成とは別に固定 5 回、#247）。 */
export const CREATION_CHECKS_USAGE_COST = MAP_GENERATION_USAGE_COST;

export type CreationChecksOutcome =
  | { status: 200; body: { checks: PersonalConceptCheck[]; failedCount: number } }
  | { status: 400 | 404 | 409 | 429 | 500 | 502 | 503; body: object };

export async function generateCreationChecks(
  deps: GenerateLearningMapDeps,
  userId: string,
  mapId: string,
  /** 設定漏れのログに載せる。 */
  path: string,
): Promise<CreationChecksOutcome> {
  const generation = deps.generation;
  const map = await deps.maps.get(userId, mapId);
  if (map === null) {
    return { status: 404, body: { error: "learning map not found" } };
  }
  const state = map.creationChecks;
  if (state === null || state.doneAt !== null || state.attempts >= MAX_CREATION_CHECK_ATTEMPTS) {
    return {
      status: 409,
      body: {
        error: "creation checks not available",
        message:
          state === null
            ? "このマップでは、作成時の確認問題を作れません（AI でマップを作るときに選んだ場合だけ作れます）。"
            : state.doneAt !== null
              ? "このマップの作成時の確認問題は作成済みです。"
              : "作成時の確認問題を作れる回数を使い切りました。問題は確認問題の画面から作れます。",
      },
    };
  }

  const configured = resolveUpstreamConfig(generation, path);
  if (!configured.ok) return { status: 503, body: notConfiguredBody() };
  const { apiKey, models } = configured.value;

  // 狙う項目: 学習の順で手前のノード（参照は除く）から、各ノードの1項目目。
  const catalog = await loadUserConceptCatalog(deps.maps, userId, {
    concepts: deps.fixedConcepts,
    objectives: deps.fixedObjectives,
  });
  const targets: CreationCheckTarget[] = [];
  for (const node of map.nodes) {
    if (targets.length >= MAX_CREATION_CHECKS) break;
    if (node.kind !== "own") continue;
    const objective = map.objectives.get(node.conceptId)?.[0];
    if (objective === undefined) continue;
    const resolved = checkPromptInputFor(node.conceptId, catalog.concepts);
    if (!resolved.ok) {
      // 読んだばかりのマップのノードが一覧に無いなら、読み取りが壊れている（RULE-004）。
      throw new Error(`map node is missing from the catalog: ${node.conceptId}`);
    }
    targets.push({
      // 手で作ったノードの領域はマップの ID なので、AI にはマップの題名を渡す。
      input: { ...resolved.input, language: map.title },
      objective: { id: objective.id, label: objective.label },
    });
  }
  if (targets.length === 0) {
    return {
      status: 400,
      body: {
        error: "no creation check targets",
        message: "「理解すること」のあるノードが無いため、確認問題を作れません。",
      },
    };
  }

  const plan = planCreationCheckBatches(targets, state.level);
  if (plan === undefined) {
    // 1組だけでも入力に収まらない。ノードと項目の文字数の上限から見て起きないはずで、方針の文面の見積もり違い。
    console.error("a single creation check does not fit the per-request input limit", { mapId });
    return { status: 500, body: { error: "creation checks prompt is too large" } };
  }
  const batches = plan.map((batch) => batch.targets);
  const prompts = plan.map((batch) => batch.prompt);

  const now = generation.now();
  const monthKey = utcMonthKey(now);
  const dayKey = utcDayKey(now);
  await deps.identity.ensureUser({ userId, nowMs: now.getTime() });
  const before = await generation.usage.get({ userId, monthKey, dayKey });
  if (before.monthlyTokens >= AI_USAGE_LIMITS.monthlyTokens) {
    console.warn("ai usage token safety valve reached", { userId, monthKey });
    return { status: 429, body: limitReached("tokens", now, "checks") };
  }
  const { reserved, usage: after } = await generation.usage.reserve({
    userId,
    monthKey,
    dayKey,
    updatedAt: now.toISOString(),
    amount: CREATION_CHECKS_USAGE_COST,
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
      after.monthlyRequests + CREATION_CHECKS_USAGE_COST > AI_USAGE_LIMITS.monthlyRequests
        ? "monthly"
        : "daily";
    return { status: 429, body: limitReached(kind, now, "checks") };
  }

  // 頼む権利を取る。状態は上で読んだが、同時に2回頼まれたときに両方を通さないよう1つの操作で取り直す。
  const level = await deps.maps.claimCreationChecks(userId, mapId, MAX_CREATION_CHECK_ATTEMPTS);
  if (level === null) {
    return {
      status: 409,
      body: {
        error: "creation checks not available",
        message: "作成時の確認問題は、別の画面で作っている途中か、作成済みです。",
      },
    };
  }

  // 上流を待つ間に学習データが削除されたら、削除前に作り始めた問題を保存しない。
  const startedAtMs = now.getTime();
  const outcomes = await Promise.all(
    batches.map(async (batch, index) => {
      const label = `map-checks:${String(index + 1)}`;
      const prompt = prompts[index]!;
      const upstream = await requestCheckGeneration({
        fetch: generation.fetch,
        apiKey,
        models,
        prompt,
        maxOutputTokens: CREATION_CHECKS_MAX_OUTPUT_TOKENS,
        retryDelaysMs: generation.retryDelaysMs ?? UPSTREAM_RETRY_DELAYS_MS,
        conceptId: label,
      });
      if (!upstream.ok) return { saved: [] as PersonalConceptCheck[], failed: batch.length };
      const generated = readGeneratedText(upstream.raw);
      // 本文が使えなくても課金は起きるので、判定より先に足す（取れなければ上界の見積もり）。
      await generation.usage.addTokens({
        userId,
        monthKey,
        dayKey,
        tokens:
          generated.totalTokens ?? estimateInputTokens(prompt) + CREATION_CHECKS_MAX_OUTPUT_TOKENS,
        updatedAt: now.toISOString(),
      });
      if (!generated.ok) {
        console.error("creation checks response was not usable", {
          label,
          reason: generated.reason,
          detail: generated.detail,
        });
        return { saved: [], failed: batch.length };
      }
      const parsed = parseCreationChecks(
        generated.text,
        batch.map((target) => target.input.id),
      );
      if (!parsed.ok) {
        console.error("creation checks were rejected", {
          label,
          reason: parsed.reason,
          detail: parsed.detail,
        });
        return { saved: [], failed: batch.length };
      }
      const saved: PersonalConceptCheck[] = [];
      let failed = 0;
      for (const [position, result] of parsed.results.entries()) {
        if (!result.ok) {
          console.error("a creation check was rejected", {
            label,
            position,
            reason: result.reason,
            detail: result.detail,
          });
          failed++;
          continue;
        }
        const target = batch[position]!;
        const check: PersonalConceptCheck = {
          ...result.check,
          scope: "objective",
          objectiveId: target.objective.id,
          level,
          model: generated.modelVersion ?? upstream.model,
          generatedAt: now.toISOString(),
        };
        const stored = await deps.generation.checks.put(userId, check, startedAtMs, {
          mapId,
          origin: "map_creation",
        });
        if (!stored.saved) {
          // 生成の間にマップ・ノード・項目か、学習データが消された。消したものの問題は残さない。
          console.info("a creation check was discarded", { label, reason: stored.reason });
          failed++;
          continue;
        }
        saved.push(check);
      }
      return { saved, failed };
    }),
  );

  const checks = outcomes.flatMap((outcome) => outcome.saved);
  const failedCount = outcomes.reduce((sum, outcome) => sum + outcome.failed, 0);
  if (checks.length === 0) {
    const attempts = (await deps.maps.get(userId, mapId))?.creationChecks?.attempts;
    const retryable = attempts !== undefined && attempts < MAX_CREATION_CHECK_ATTEMPTS;
    return {
      status: 502,
      body: {
        error: "creation checks failed",
        message: retryable
          ? "確認問題を作れませんでした。もう一度だけ作り直せます。"
          : "確認問題を作れませんでした。問題は確認問題の画面から1組ずつ作れます。",
        retryable,
      },
    };
  }
  if (!(await deps.maps.completeCreationChecks(userId, mapId, now.toISOString()))) {
    // 作っている間にマップが消された。問題もマップと一緒に消えている。
    return { status: 404, body: { error: "learning map not found" } };
  }
  console.info("creation checks completed", {
    mapId,
    saved: checks.length,
    failed: failedCount,
  });
  return { status: 200, body: { checks, failedCount } };
}

/** 作成時の問題を頼む1回分。 */
export interface CreationCheckBatch {
  targets: CreationCheckTarget[];
  prompt: string;
}

/**
 * 狙う項目を、1回 {@link CHECKS_PER_REQUEST} 組ずつに分ける。
 *
 * 2組が入力の上限に収まらなければ（手で概要や項目を長く直したときなど）1組ずつにする。
 * 呼び出しが増えて、5 回分の上界（入力の見積もり + 出力上限の合計）を超えるなら、
 * 後ろ（学習の順で奥）の組から落とす。作れる分だけ作る（最大 10 組、決定 C1）。
 *
 * @returns 1組だけでも入力に収まらなければ `undefined`。
 */
export function planCreationCheckBatches(
  targets: readonly CreationCheckTarget[],
  level: CheckLevel,
): CreationCheckBatch[] | undefined {
  const batchOf = (group: CreationCheckTarget[]) => ({
    targets: group,
    prompt: buildCreationChecksPrompt(group, level),
  });
  const fits = (batch: CreationCheckBatch) =>
    estimateInputTokens(batch.prompt) <= AI_USAGE_LIMITS.inputTokensPerRequest;

  const batches: CreationCheckBatch[] = [];
  for (let index = 0; index < targets.length; index += CHECKS_PER_REQUEST) {
    const group = targets.slice(index, index + CHECKS_PER_REQUEST);
    const together = batchOf(group);
    if (fits(together)) {
      batches.push(together);
      continue;
    }
    for (const target of group) {
      const single = batchOf([target]);
      if (!fits(single)) return undefined;
      batches.push(single);
    }
  }
  const cost = (batch: CreationCheckBatch) =>
    estimateInputTokens(batch.prompt) + CREATION_CHECKS_MAX_OUTPUT_TOKENS;
  let total = batches.reduce((sum, batch) => sum + cost(batch), 0);
  const planned = batches.length;
  while (total > MAP_GENERATION_TOKEN_BUDGET && batches.length > 1) {
    total -= cost(batches.pop()!);
  }
  if (batches.length < planned) {
    console.info("creation checks were reduced to fit the token budget", {
      planned,
      kept: batches.length,
    });
  }
  return batches;
}
