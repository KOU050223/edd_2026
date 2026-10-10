/**
 * リポジトリからのマップの AI 呼び出し（#249）。上流（Gemini）への送信・送り直しは
 * `checks/upstream.ts` を使い、ここは応答の検証と、呼び出しごとのトークンの記録を持つ。
 *
 * **形が揃わない応答は受理しない。** 選択の応答が配列でなければ、空として進めず失敗にする（RULE-004）。
 * 失敗した呼び出しも、課金が起きているので記録する。
 */

import { upstreamFailureBody } from "../checks/errors.js";
import { readGeneratedText } from "../checks/response.js";
import { requestCheckGeneration } from "../checks/upstream.js";
import { AI_USAGE_LIMITS, isAllowedModel, type AllowedModel } from "../contract/ai-usage.js";
import { byteLength } from "./prompts.js";
import type { AiCallRecord } from "./repository.js";

/** 1 マップの下書きで許す AI の呼び出しの回数。実測の最大は 17 回（スパイク）。繰り返しの暴走を止める。 */
export const MAX_AI_CALLS_PER_DRAFT = 40;
/** 要約・選択の思考に使ってよいトークン。出力が思考で切れないように絞る（スパイクの知見）。 */
export const SUMMARY_THINKING_BUDGET = 256;
export const SUMMARY_MAX_OUTPUT_TOKENS = 600;
export const SELECT_MAX_OUTPUT_TOKENS = 1_200;

export interface RepoMapAiConfig {
  apiKey: string | undefined;
  fetch: typeof fetch;
  /** 順に試すモデル。allowlist を通らないものがあれば設定の誤りとして失敗にする。 */
  models: readonly string[];
  retryDelaysMs?: readonly number[];
}

/** AI の段の失敗。ルートが応答にする。 */
export class AiStageFailure extends Error {
  constructor(
    readonly kind: "not_configured" | "upstream" | "unusable" | "call_limit",
    readonly status: 429 | 502 | 503,
    readonly body: object,
    message: string,
  ) {
    super(message);
    this.name = "AiStageFailure";
  }
}

/** 応答の `usageMetadata` から入力・出力（思考を含む）のトークンを読む。取れなければ見積もりで補う。 */
function tokensOf(raw: string, prompt: string, totalTokens: number | undefined) {
  let meta: {
    promptTokenCount?: unknown;
    candidatesTokenCount?: unknown;
    totalTokenCount?: unknown;
  } = {};
  try {
    const parsed = JSON.parse(raw) as { usageMetadata?: typeof meta };
    meta = parsed.usageMetadata ?? {};
  } catch {
    // 本文は readGeneratedText が先に検証している。ここで読めないなら見積もりで補う。
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const input = num(meta.promptTokenCount) ?? byteLength(prompt);
  const total = totalTokens ?? num(meta.totalTokenCount);
  const output =
    total !== undefined ? Math.max(0, total - input) : (num(meta.candidatesTokenCount) ?? 0);
  return {
    input,
    output,
    estimated: total === undefined && num(meta.promptTokenCount) === undefined,
  };
}

/** 1 回の下書きの段で使う AI。呼び出しを `calls` に貯め、段の終わりにまとめて記録する。 */
export class AiSession {
  readonly calls: AiCallRecord[] = [];
  private readonly models: AllowedModel[];

  /**
   * 1 回の呼び出しで送りうる最大の回数（モデルの数 × 巡の数）。外部呼び出しの上限に収めるため、
   * 呼び出し側が送る前にこの分の余裕を確かめる。待って送り直すより、段を分けて続きから再開する。
   */
  get worstCaseAttempts(): number {
    return this.models.length * (this.retryDelaysMs.length + 1);
  }

  private get retryDelaysMs(): readonly number[] {
    return this.config.retryDelaysMs ?? [];
  }

  /**
   * `callLimit` は、この下書きがこのあと使ってよい AI の呼び出しの回数（上限から記録済みの分を引いた値）。
   * 送る前に 1 回ずつ確かめるので、段の途中でも超えない。
   */
  constructor(
    private readonly config: RepoMapAiConfig,
    private readonly callLimit: number = Number.POSITIVE_INFINITY,
  ) {
    const allowed = config.models.filter(isAllowedModel);
    if (allowed.length !== config.models.length || allowed.length === 0) {
      console.error("repo map models are not allowed or empty", { models: config.models });
      throw new AiStageFailure("not_configured", 503, notConfiguredBody(), "models not allowed");
    }
    this.models = allowed;
  }

  /** プロンプトを送り、JSON として読めた値を返す。 */
  async json(
    stage: AiCallRecord["stage"],
    label: string,
    prompt: string,
    options: { maxOutputTokens: number; thinkingBudget?: number },
  ): Promise<unknown> {
    if (this.calls.length >= this.callLimit) {
      throw new AiStageFailure(
        "call_limit",
        429,
        {
          error: "quota_exceeded",
          message:
            "この下書きで使える AI の呼び出しの上限に達しました。新しい下書きを作ってください。",
          limit: MAX_AI_CALLS_PER_DRAFT,
        },
        "draft ai call limit",
      );
    }
    if (!this.config.apiKey) {
      console.error("ai service is not configured", { label });
      throw new AiStageFailure("not_configured", 503, notConfiguredBody(), "no api key");
    }
    // 入力の上限は UTF-8 のバイト数で見る（docs/ai-limits.md）。超えるのは組み立ての誤り。
    if (byteLength(prompt) > AI_USAGE_LIMITS.inputTokensPerRequest) {
      throw new Error(
        `repo map prompt is too large (${String(byteLength(prompt))} bytes): ${label}`,
      );
    }
    const upstream = await requestCheckGeneration({
      fetch: this.config.fetch,
      apiKey: this.config.apiKey,
      models: this.models,
      prompt,
      maxOutputTokens: options.maxOutputTokens,
      ...(options.thinkingBudget === undefined ? {} : { thinkingBudget: options.thinkingBudget }),
      retryDelaysMs: this.retryDelaysMs,
      conceptId: `repo-map:${label}`,
    });
    if (!upstream.ok) {
      throw new AiStageFailure(
        "upstream",
        502,
        upstreamFailureBody(upstream.reason, upstream.trace, upstream.status),
        `upstream ${upstream.reason}`,
      );
    }
    const generated = readGeneratedText(upstream.raw);
    const { input, output, estimated } = tokensOf(upstream.raw, prompt, generated.totalTokens);
    if (estimated) {
      console.warn("repo map did not report token usage; using an estimate", { label });
    }
    const record = { stage, model: upstream.model, inputTokens: input, outputTokens: output };
    if (!generated.ok) {
      this.calls.push({ ...record, ok: false });
      console.error("repo map response was not usable", {
        label,
        model: upstream.model,
        reason: generated.reason,
        detail: generated.detail,
      });
      throw new AiStageFailure(
        "unusable",
        502,
        {
          error: "ai_response_unusable",
          reason: generated.reason,
          message: "AI の応答を読み取れませんでした。もう一度お試しください。",
        },
        `unusable ${generated.reason}`,
      );
    }
    try {
      const value: unknown = JSON.parse(generated.text);
      this.calls.push({ ...record, ok: true });
      return value;
    } catch {
      this.calls.push({ ...record, ok: false });
      console.error("repo map response was not JSON", { label, model: upstream.model });
      throw new AiStageFailure(
        "unusable",
        502,
        {
          error: "ai_response_unusable",
          reason: "not-json",
          message: "AI の応答を読み取れませんでした。もう一度お試しください。",
        },
        "unusable not-json",
      );
    }
  }
}

function notConfiguredBody() {
  return {
    error: "ai_not_configured",
    message: "AI の設定に問題があります。時間をおいても直らない場合は運営に連絡してください。",
  };
}
