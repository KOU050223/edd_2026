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
  planLimits,
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
/**
 * 作っている最中の印の有効期間。上流の期限（150 秒）× 並列の呼び出しが終わるのに十分な長さにし、
 * これを過ぎた印は、Worker が途中で止まった要求の残りとして無視する（PR #284 のレビュー）。
 */
export const CREATION_CHECKS_LEASE_MS = 10 * 60 * 1000;
/** 作成時の問題で `ai_usage` から引く回数（マップの生成とは別に固定 5 回、#247）。 */
export const CREATION_CHECKS_USAGE_COST = MAP_GENERATION_USAGE_COST;

export type CreationChecksOutcome =
  | {
      status: 200;
      body: { checks: PersonalConceptCheck[]; failedCount: number; skippedCount: number };
    }
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

  const { batches: plan, skipped: skippedCount } = planCreationCheckBatches(targets, state.level);
  if (plan.length === 0) {
    // どのノードも入力に収まらない（手で概要や項目を長く直したときなど）。回数を使う前に止める。
    return {
      status: 400,
      body: {
        error: "no creation check targets",
        message:
          "ノードの説明が長すぎるため、確認問題を作れませんでした。問題は確認問題の画面から1組ずつ作れます。",
      },
    };
  }
  const batches = plan.map((batch) => batch.targets);
  const prompts = plan.map((batch) => batch.prompt);

  const now = generation.now();
  const monthKey = utcMonthKey(now);
  const dayKey = utcDayKey(now);

  // 頼む権利を先に取る。状態は上で読んだが、同時に2回頼まれたときに両方を通さないよう、
  // 作っている最中の印と一緒に1つの操作で取り直す（PR #284 のレビュー）。
  // 回数の確保より前に取るのは、権利の取り合いで負けた要求に回数を使わせないため。
  const level = await deps.maps.claimCreationChecks(userId, mapId, {
    maxAttempts: MAX_CREATION_CHECK_ATTEMPTS,
    nowMs: now.getTime(),
    leaseMs: CREATION_CHECKS_LEASE_MS,
  });
  if (level === null) {
    return {
      status: 409,
      body: {
        error: "creation checks not available",
        message: "作成時の確認問題は、別の画面で作っている途中か、作成済みです。",
      },
    };
  }
  // 権利を取ったあとに例外が出ても、印と回数を残したままにしない（PR #284 の CodeRabbit のレビュー）。
  // `settled` は印の後始末（戻す・外す・作成済みにする）を済ませたか。
  let settled = false;
  let sentUpstream = false;
  let savedAny = false;
  try {
    /** 上流へ送る前に止めるとき。頼んだ回数を戻して、印を外す。 */
    const giveBack = async () => {
      await deps.maps.releaseCreationChecks(userId, mapId, { refundAttempt: true });
      settled = true;
    };

    await deps.identity.ensureUser({ userId, nowMs: now.getTime() });
    const limits = planLimits(
      await generation.plans.get(userId),
      generation.enforceUsageLimits !== false,
    );
    const before = await generation.usage.get({ userId, monthKey, dayKey });
    if (before.monthlyTokens >= limits.monthlyTokens) {
      console.warn("ai usage token safety valve reached", { userId, monthKey });
      await giveBack();
      return { status: 429, body: limitReached("tokens", now, "checks") };
    }
    const { reserved, usage: after } = await generation.usage.reserve({
      userId,
      monthKey,
      dayKey,
      updatedAt: now.toISOString(),
      amount: CREATION_CHECKS_USAGE_COST,
      limits: { dailyRequests: limits.dailyRequests, monthlyRequests: limits.monthlyRequests },
    });
    if (!reserved) {
      await giveBack();
      const kind: AiUsageLimitKind =
        after.monthlyRequests + CREATION_CHECKS_USAGE_COST > limits.monthlyRequests
          ? "monthly"
          : "daily";
      return { status: 429, body: limitReached(kind, now, "checks") };
    }

    // 上流を待つ間に学習データが削除されたら、削除前に作り始めた問題を保存しない。
    const startedAtMs = now.getTime();
    sentUpstream = true;
    // 1つが例外で止まっても他を待つ。待たずに後始末をすると、そのあとに保存された組が残るのに
    // 状態が「未作成」のままになる。
    const results = await Promise.allSettled(
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
            generated.totalTokens ??
            estimateInputTokens(prompt) + CREATION_CHECKS_MAX_OUTPUT_TOKENS,
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
          savedAny = true;
        }
        return { saved, failed };
      }),
    );
    const outcomes = results.map((result) => {
      // 例外は飲み込まずにそのまま伝える。後始末は finally で行う。
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });

    const checks = outcomes.flatMap((outcome) => outcome.saved);
    const failedCount = outcomes.reduce((sum, outcome) => sum + outcome.failed, 0);
    if (checks.length === 0) {
      // 上流へは送ったので、頼んだ回数は戻さない。印だけ外して、残りの回数で頼み直せるようにする。
      await deps.maps.releaseCreationChecks(userId, mapId, { refundAttempt: false });
      settled = true;
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
    const completed = await deps.maps.completeCreationChecks(userId, mapId, now.toISOString());
    settled = true;
    if (!completed) {
      // 作っている間にマップが消された。問題もマップと一緒に消えている。
      return { status: 404, body: { error: "learning map not found" } };
    }
    console.info("creation checks completed", {
      mapId,
      saved: checks.length,
      failed: failedCount,
      skipped: skippedCount,
    });
    return { status: 200, body: { checks, failedCount, skippedCount } };
  } finally {
    if (!settled) {
      await settleAfterThrow(deps, userId, mapId, {
        sentUpstream,
        savedAny,
        nowIso: now.toISOString(),
      });
    }
  }
}

/**
 * 権利を取ったあとに例外が出たときの後始末。保存できた組があれば作成済みにし、
 * 無ければ印を外す（上流へ送る前なら頼んだ回数も戻す）。
 *
 * 後始末の失敗はログに残し、元の例外をそのまま伝える（後始末の失敗で原因を上書きしない）。
 * 印は有効期間を過ぎれば無視されるので、後始末に失敗しても固まりはしない。
 */
async function settleAfterThrow(
  deps: GenerateLearningMapDeps,
  userId: string,
  mapId: string,
  state: { sentUpstream: boolean; savedAny: boolean; nowIso: string },
): Promise<void> {
  try {
    if (state.savedAny) {
      await deps.maps.completeCreationChecks(userId, mapId, state.nowIso);
    } else {
      await deps.maps.releaseCreationChecks(userId, mapId, { refundAttempt: !state.sentUpstream });
    }
  } catch (cause) {
    console.error("creation checks could not be settled after a failure", { mapId, cause });
  }
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
 * 1組でも収まらない項目は飛ばす（他の項目まで止めない。PR #284 のレビュー）。
 * 呼び出しが増えて、5 回分の上界（入力の見積もり + 出力上限の合計）を超えるなら、
 * 後ろ（学習の順で奥）の組から落とす。作れる分だけ作る（最大 10 組、決定 C1）。
 *
 * @returns 頼む分と、飛ばした・落とした項目の数。
 */
export function planCreationCheckBatches(
  targets: readonly CreationCheckTarget[],
  level: CheckLevel,
): { batches: CreationCheckBatch[]; skipped: number } {
  const batchOf = (group: CreationCheckTarget[]) => ({
    targets: group,
    prompt: buildCreationChecksPrompt(group, level),
  });
  const fits = (batch: CreationCheckBatch) =>
    estimateInputTokens(batch.prompt) <= AI_USAGE_LIMITS.inputTokensPerRequest;

  const batches: CreationCheckBatch[] = [];
  let tooLarge = 0;
  for (let index = 0; index < targets.length; index += CHECKS_PER_REQUEST) {
    const group = targets.slice(index, index + CHECKS_PER_REQUEST);
    const together = batchOf(group);
    if (fits(together)) {
      batches.push(together);
      continue;
    }
    for (const target of group) {
      const single = batchOf([target]);
      if (fits(single)) batches.push(single);
      else tooLarge++;
    }
  }
  const cost = (batch: CreationCheckBatch) =>
    estimateInputTokens(batch.prompt) + CREATION_CHECKS_MAX_OUTPUT_TOKENS;
  let total = batches.reduce((sum, batch) => sum + cost(batch), 0);
  let dropped = 0;
  while (total > MAP_GENERATION_TOKEN_BUDGET && batches.length > 1) {
    const last = batches.pop()!;
    total -= cost(last);
    dropped += last.targets.length;
  }
  if (tooLarge > 0 || dropped > 0) {
    console.info("some creation checks were skipped to fit the input limit or token budget", {
      targets: targets.length,
      tooLarge,
      dropped,
    });
  }
  return { batches, skipped: tooLarge + dropped };
}
