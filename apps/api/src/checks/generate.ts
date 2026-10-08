/**
 * `POST /v1/checks:generate` の本体。1組を生成して保存する。
 *
 * ルート（`routes/checks.ts`）は検証済みの入力を渡し、返った状態コードと本文をそのまま返す。
 * ここは Hono に依存しない。流れは次の順で、どこで止まっても上流へは送らない。
 *
 * 1. 対象（Concept と「理解すること」）を確かめる
 * 2. 生成の同意を確かめる
 * 3. 設定（API キー、モデルの allowlist）を確かめる
 * 4. プロンプトを組む（材料は入力上限に収める）
 * 5. 回数を確保する
 * 6. 上流へ送り、実消費を数え、問題として検証して保存する
 */

import * as v from "valibot";
import {
  CHECK_GENERATION_CONSENT_VERSION,
  CHECK_LEVELS,
  CHECK_SCOPES,
  CONCEPT_ID_PATTERN,
  CONCEPT_BY_ID,
  CONCEPTS,
  LEARNING_OBJECTIVE_ID_PATTERN,
  type LearningObjective,
  type PersonalConceptCheck,
} from "@gakushu-sochi/domain";
import {
  AI_USAGE_LIMITS,
  planLimits,
  ALLOWED_MODELS,
  estimateInputTokens,
  isAllowedModel,
  utcDayKey,
  utcMonthKey,
  type AiUsageLimitKind,
  type AllowedModel,
} from "../contract/ai-usage.js";
import type { ChecksDeps } from "./deps.js";
import { failureBody, limitReached, notConfiguredBody, upstreamFailureBody } from "./errors.js";
import { loadUserConceptCatalog } from "../maps/catalog.js";
import { fitQuestionsToInputLimit, solvedQuestionsFor } from "./material.js";
import {
  buildCheckPrompt,
  checkPromptInputFor,
  type CheckPromptInput,
  type CheckRequest,
} from "./prompt.js";
import { parseConceptCheck, readGeneratedText } from "./response.js";
import { requestCheckGeneration, UPSTREAM_RETRY_DELAYS_MS } from "./upstream.js";

// 既知の ID かどうかは `checkPromptInputFor` が判定する。ここは形式だけを見る。
// 長さの上限を置くのは、巨大な文字列で照合を走らせないため。
export const conceptIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(200),
  v.regex(CONCEPT_ID_PATTERN),
);

export const generateSchema = v.object({
  conceptId: conceptIdSchema,
  scope: v.picklist(CHECK_SCOPES),
  level: v.picklist(CHECK_LEVELS),
  objectiveId: v.optional(
    v.pipe(v.string(), v.maxLength(300), v.regex(LEARNING_OBJECTIVE_ID_PATTERN)),
  ),
  /** 生成の画面でその場で同意した文面の版。「今後表示しない」の記録があれば省略できる。 */
  consentVersion: v.optional(v.pipe(v.number(), v.integer())),
});

export type GenerateCheckInput = v.InferOutput<typeof generateSchema>;

/** ルートがそのまま返す状態コードと本文。 */
export type GenerateCheckOutcome =
  | { status: 200; body: PersonalConceptCheck }
  | { status: 400 | 403 | 409 | 429 | 500 | 502 | 503; body: object };

/** 途中で止まるなら応答を、進めるなら次に要る値を返す。 */
type Step<T> = { ok: true; value: T } | { ok: false; outcome: GenerateCheckOutcome };

export async function generateCheck(
  deps: ChecksDeps,
  userId: string,
  input: GenerateCheckInput,
  /** 設定漏れのログに載せる。 */
  path: string,
): Promise<GenerateCheckOutcome> {
  const { conceptId, scope, level } = input;

  const target = await resolveTarget(deps, userId, input);
  if (!target.ok) return target.outcome;
  const { promptInput, objective, mapId } = target.value;

  const consent = await checkConsent(deps, userId, input.consentVersion);
  if (!consent.ok) return consent.outcome;

  const configured = resolveUpstreamConfig(deps, path);
  if (!configured.ok) return configured.outcome;
  const { apiKey, models } = configured.value;

  // 材料（学習イベントと会話）を読む前の時刻。上流を待つ間に学習データが削除されたら、
  // 削除前の履歴から作った問題を保存しない（`PersonalCheckRepository.put`）。
  const startedAtMs = deps.now().getTime();
  const built = await buildRequest(deps, userId, input, promptInput, objective);
  if (!built.ok) return built.outcome;
  const { request, prompt } = built.value;
  const estimatedInputTokens = estimateInputTokens(prompt);

  const now = deps.now();
  const reserved = await reserveUsage(deps, userId, now);
  if (!reserved.ok) return reserved.outcome;
  const { monthKey, dayKey } = reserved.value;

  const upstream = await requestCheckGeneration({
    fetch: deps.fetch,
    apiKey,
    models,
    prompt,
    retryDelaysMs: deps.retryDelaysMs ?? UPSTREAM_RETRY_DELAYS_MS,
    conceptId,
  });
  if (!upstream.ok) {
    return {
      status: 502,
      body: upstreamFailureBody(upstream.reason, upstream.trace, upstream.status),
    };
  }
  const { model } = upstream;

  // 実消費を当月へ足す。本文が使えない応答（切れた・空・拒否）でも上流では課金されるので、
  // 判定より先に足す。取れなければ 0 で済ませず、上界の見積もりを足して残す（RULE-004）。
  const generated = readGeneratedText(upstream.raw);
  const tokens =
    generated.totalTokens ?? estimatedInputTokens + AI_USAGE_LIMITS.outputTokensPerRequest;
  if (generated.totalTokens === undefined) {
    console.warn("check generation did not report token usage; adding an estimate", {
      conceptId,
      model,
      tokens,
    });
  }
  await deps.usage.addTokens({
    userId,
    monthKey,
    dayKey,
    tokens,
    updatedAt: now.toISOString(),
  });

  if (!generated.ok) {
    console.error("check generation response was not usable", {
      conceptId,
      model,
      reason: generated.reason,
      detail: generated.detail,
    });
    return { status: 502, body: failureBody(generated.reason, generated.finishReason) };
  }

  const parsed = parseConceptCheck(generated.text, promptInput.id);
  if (!parsed.ok) {
    console.error("generated check was rejected", {
      conceptId,
      model,
      reason: parsed.reason,
      detail: parsed.detail,
    });
    return { status: 502, body: failureBody(parsed.reason) };
  }

  const check: PersonalConceptCheck = {
    ...parsed.check,
    scope,
    level,
    ...(objective === undefined ? {} : { objectiveId: objective.id }),
    model: generated.modelVersion ?? model,
    generatedAt: now.toISOString(),
  };
  // 保存に失敗したら例外のまま 500 にする。問題だけ返して保存の失敗を飲み込むと、
  // 次に開いたときに問題が無く、回数だけが減っている（RULE-004）。
  const stored = await deps.checks.put(
    userId,
    check,
    startedAtMs,
    mapId === undefined ? undefined : { mapId },
  );
  if (!stored.saved && stored.reason === "target-removed") {
    // 生成中に、手で作ったマップ・ノード・狙った項目が消された（#242）。消したものの問題は残さない。
    console.info("generated check was discarded because its map node was removed", { conceptId });
    return {
      status: 409,
      body: {
        error: "check discarded by map change",
        message:
          "生成中にマップ・ノード・「理解すること」が削除されたため、作った問題は保存しませんでした。",
      },
    };
  }
  if (!stored.saved) {
    // 生成中に学習データが削除された。削除を優先し、作った問題は返さない。
    console.info("generated check was discarded by a learning data reset", { conceptId });
    return {
      status: 409,
      body: {
        error: "check discarded by reset",
        message: "生成中に学習データが削除されたため、作った問題は保存しませんでした。",
      },
    };
  }

  // その場の同意は、生成のたびに記録しない。「今後表示しない」は PUT で別に記録する。
  console.info("check generation completed", {
    conceptId,
    scope,
    level,
    materialCount: request.solvedQuestions.length,
    model: check.model,
    totalTokens: generated.totalTokens ?? "unknown",
  });
  return { status: 200, body: check };
}

/**
 * Concept が既知で、狙う項目がその Concept の「理解すること」の一覧にあるかを確かめる。
 *
 * 既知の Concept は、固定の一覧と、利用者が手で作ったマップのノード（#242）。
 */
async function resolveTarget(
  deps: ChecksDeps,
  userId: string,
  { conceptId, scope, objectiveId }: GenerateCheckInput,
): Promise<
  Step<{
    promptInput: CheckPromptInput;
    objective: LearningObjective | undefined;
    /** 手で作ったマップのノードなら、そのマップの ID。保存の直前にノードがまだあるか確かめる。 */
    mapId: string | undefined;
  }>
> {
  const catalog = await loadUserConceptCatalog(deps.maps, userId);
  // 固定の Concept は固定の一覧だけで前提・次を引く。手で作ったマップの線を混ぜると、
  // 同じ Concept でも利用者ごとにプロンプトが変わる。
  const fixed = CONCEPT_BY_ID.has(conceptId);
  const resolved = checkPromptInputFor(conceptId, fixed ? CONCEPTS : catalog.concepts);
  if (!resolved.ok) {
    if (resolved.reason === "unknown-concept") {
      return {
        ok: false,
        outcome: {
          status: 400,
          body: {
            error: "unknown concept",
            message: "その概念は一覧にありません。確認問題を作れる概念を選んでください。",
          },
        },
      };
    }
    // 概要の無い Concept は定義の不備であり、利用者の失敗ではない（RULE-004）。
    console.error("concept has no summary; refusing to generate a check", { conceptId });
    return {
      ok: false,
      outcome: { status: 500, body: { error: "concept definition is incomplete" } },
    };
  }

  // 狙う項目は、その Concept の「理解すること」の一覧にあるものだけを受け付ける。
  const objectives = catalog.objectives.filter((candidate) => candidate.conceptId === conceptId);
  const objective =
    objectiveId === undefined
      ? undefined
      : objectives.find((candidate) => candidate.id === objectiveId);
  if (scope === "objective" ? objective === undefined : objectiveId !== undefined) {
    return {
      ok: false,
      outcome: {
        status: 400,
        body: {
          error: "invalid objective",
          message:
            scope === "objective"
              ? "その「理解すること」はこの概念にありません。項目を選び直してください。"
              : "「理解すること」を選んだときだけ、項目を指定できます。",
        },
      },
    };
  }
  // 項目を持つ Concept では、項目を狙わない組を作らない。正誤が項目の理解度に効かない
  // （#223 決定 6）。画面の「Concept 単位」は、まだ 1.0 でない項目ごとに1組を作る（#236）。
  if (scope === "concept" && objectives.length > 0) {
    return {
      ok: false,
      outcome: {
        status: 400,
        body: {
          error: "invalid objective",
          message: "この概念は「理解すること」の項目ごとに問題を作ります。項目を選んでください。",
        },
      },
    };
  }
  // 手で作ったノードの領域はマップの ID なので、AI にはマップの題名を渡す。
  const areaLabel = catalog.areaLabelOf(resolved.input.language);
  const promptInput =
    areaLabel === undefined ? resolved.input : { ...resolved.input, language: areaLabel };
  const mapId = fixed ? undefined : resolved.input.language;
  return { ok: true, value: { promptInput, objective, mapId } };
}

/** 送る前に同意を確かめる。その場の同意か、「今後表示しない」の記録のどちらか。 */
async function checkConsent(
  deps: ChecksDeps,
  userId: string,
  consentVersion: number | undefined,
): Promise<Step<undefined>> {
  if (consentVersion === CHECK_GENERATION_CONSENT_VERSION) return { ok: true, value: undefined };
  const stored = await deps.consents.get(userId);
  if (stored?.version === CHECK_GENERATION_CONSENT_VERSION) return { ok: true, value: undefined };
  return {
    ok: false,
    outcome: {
      status: 403,
      body: {
        error: "check generation consent required",
        message: "問題を作る前に、AI へ送る内容を確認して同意してください。",
        version: CHECK_GENERATION_CONSENT_VERSION,
      },
    },
  };
}

/** API キーと、送ってよいモデルの並びを確かめる。どちらの不備も運営側の障害として 503。 */
function resolveUpstreamConfig(
  deps: ChecksDeps,
  path: string,
): Step<{ apiKey: string; models: AllowedModel[] }> {
  if (!deps.apiKey) {
    // 設定漏れは運営側の障害である。503 だけでは Workers のログから区別できない。
    console.error("ai service is not configured", { path });
    return { ok: false, outcome: { status: 503, body: notConfiguredBody() } };
  }
  // クライアントにモデルを選ばせない。設定値であっても allowlist は通す。
  // 1つでも許可外があれば、単価を確かめていないモデルへ送らないよう全体を止める。
  const configured =
    deps.models !== undefined && deps.models.length > 0
      ? deps.models
      : [deps.model ?? ALLOWED_MODELS[0]];
  const models = configured.filter(isAllowedModel);
  if (models.length !== configured.length) {
    console.error("configured model is not allowed", {
      models: configured,
      allowed: ALLOWED_MODELS,
    });
    return { ok: false, outcome: { status: 503, body: notConfiguredBody() } };
  }
  return { ok: true, value: { apiKey: deps.apiKey, models } };
}

/** プロンプトを組む。材料（自力解決した質問）は「理解すること」を狙う組にだけ載せる。 */
async function buildRequest(
  deps: ChecksDeps,
  userId: string,
  { conceptId, scope, level }: GenerateCheckInput,
  promptInput: CheckPromptInput,
  objective: LearningObjective | undefined,
): Promise<Step<{ request: CheckRequest; prompt: string }>> {
  const base: CheckRequest = {
    scope,
    level,
    ...(objective === undefined ? {} : { objective: { id: objective.id, label: objective.label } }),
    solvedQuestions: [],
  };
  // 材料の無いプロンプトが上限を超えるのは、定義と方針の文面の見積もり違いである。
  // 利用者には縮めようがないため、こちらの不備として 500 を返す。
  if (
    estimateInputTokens(buildCheckPrompt(promptInput, base)) > AI_USAGE_LIMITS.inputTokensPerRequest
  ) {
    console.error("check prompt exceeds the per-request input limit without material", {
      conceptId,
      limit: AI_USAGE_LIMITS.inputTokensPerRequest,
    });
    return { ok: false, outcome: { status: 500, body: { error: "check prompt is too large" } } };
  }
  const request: CheckRequest = {
    ...base,
    solvedQuestions:
      objective === undefined
        ? []
        : fitQuestionsToInputLimit(
            promptInput,
            base,
            await solvedQuestionsFor(deps, userId, objective.id),
          ),
  };
  return { ok: true, value: { request, prompt: buildCheckPrompt(promptInput, request) } };
}

/** 1組の生成につき1回を確保する。上流へ送る前に行う（`ai.ts` と同じ理由）。 */
async function reserveUsage(
  deps: ChecksDeps,
  userId: string,
  now: Date,
): Promise<Step<{ monthKey: string; dayKey: string }>> {
  const monthKey = utcMonthKey(now);
  const dayKey = utcDayKey(now);
  // `ai_usage.user_id` は `users(id)` を参照する。行が無いまま数えると外部キーで落ちる。
  await deps.identity.ensureUser({ userId, nowMs: now.getTime() });
  // 上限を外しているとき（テスト中、#255）も加算はして、使った回数を残す。
  const limits = planLimits(await deps.plans.get(userId), deps.enforceUsageLimits !== false);

  // トークンの安全弁は前回までの累計で見る（`ai.ts` と同じ）。
  const before = await deps.usage.get({ userId, monthKey, dayKey });
  if (before.monthlyTokens >= limits.monthlyTokens) {
    console.warn("ai usage token safety valve reached", {
      userId,
      monthKey,
      monthlyTokens: before.monthlyTokens,
      limit: limits.monthlyTokens,
    });
    return { ok: false, outcome: { status: 429, body: limitReached("tokens", now, limits) } };
  }
  // 判定と加算を1つの操作で行う。
  const { reserved, usage: after } = await deps.usage.reserve({
    userId,
    monthKey,
    dayKey,
    updatedAt: now.toISOString(),
    limits: { dailyRequests: limits.dailyRequests, monthlyRequests: limits.monthlyRequests },
  });
  if (!reserved) {
    const kind: AiUsageLimitKind =
      after.monthlyRequests >= limits.monthlyRequests ? "monthly" : "daily";
    return { ok: false, outcome: { status: 429, body: limitReached(kind, now, limits) } };
  }
  return { ok: true, value: { monthKey, dayKey } };
}
