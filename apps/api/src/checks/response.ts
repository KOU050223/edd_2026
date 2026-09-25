/**
 * 生成された確認問題の受理と検証（#184）。
 *
 * **形が揃わない応答は受理しない。** 2問揃っていない、選択肢の数が違う、
 * 正解が選択肢の範囲外、別の Concept の問題が返った、といった応答を
 * 「取れた分だけ」使うと、利用者には理解度を測れない問題が出題され、
 * その正誤が `check_passed` / `check_failed` として習熟度へ入る。
 * 失敗は必ず理由付きの値で返し、呼び出し側が利用者へ伝えられるようにする
 * （AGENTS.md「エラーを握りつぶすな」/ RULE-004）。
 *
 * 2段構えになっている。上流の封筒（Gemini の `generateContent` の応答）から
 * 本文を取り出す {@link readGeneratedText} と、本文を確認問題として読む
 * {@link parseConceptCheck} である。前者は上流の都合、後者は出題の契約を見る。
 */

import * as v from "valibot";
import { CHECK_LIMITS, type ConceptCheck, type ConceptId } from "@gakushu-sochi/domain";

/** 上流の応答から本文を取り出せなかった理由。 */
export type GeneratedTextFailure =
  /** 本文が JSON として読めない。 */
  | "not-json"
  /** 安全性フィルタなどで生成そのものが拒否された。 */
  | "blocked"
  /** 候補も本文も無い。 */
  | "no-text"
  /** 出力上限に当たって途中で切れた。 */
  | "truncated";

export type GeneratedTextResult =
  | {
      ok: true;
      text: string;
      /** 上流が報告したモデル名。要求したモデルと違うことがあるため、応答側を採る。 */
      modelVersion?: string;
      /**
       * 消費トークンの合計。**取れなければ `undefined` のままにする。**
       * 0 として扱うと、生成のコストが「消費していない」と記録される。
       */
      totalTokens?: number;
    }
  | { ok: false; reason: GeneratedTextFailure; detail?: string };

/**
 * Gemini の `generateContent` の応答（非ストリーミング）から本文を取り出す。
 *
 * ストリーミングを使わないのは、**全文が揃わないと検証できない**ため。
 * 2問1組であることも正解の位置も、途中のチャンクでは判定できない。
 */
export function readGeneratedText(raw: string): GeneratedTextResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return { ok: false, reason: "not-json", detail: messageOf(cause) };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "not-json", detail: "応答の最上位がオブジェクトでない" };
  }

  const body = parsed as {
    candidates?: unknown;
    promptFeedback?: { blockReason?: unknown };
    usageMetadata?: { totalTokenCount?: unknown };
    modelVersion?: unknown;
  };

  const blockReason = body.promptFeedback?.blockReason;
  if (typeof blockReason === "string" && blockReason !== "") {
    return { ok: false, reason: "blocked", detail: blockReason };
  }

  const candidate = Array.isArray(body.candidates) ? (body.candidates[0] as unknown) : undefined;
  if (typeof candidate !== "object" || candidate === null) {
    return { ok: false, reason: "no-text", detail: "candidates が空" };
  }
  const { content, finishReason } = candidate as { content?: unknown; finishReason?: unknown };
  // 上限に当たって切れた応答は、JSON として壊れているかどうかに関わらず拒否する。
  // 途中まで読めた JSON を受理すると、切り詰められた問題文が出題される。
  if (finishReason === "MAX_TOKENS") {
    return { ok: false, reason: "truncated", detail: "出力上限に達した" };
  }
  const parts = (content as { parts?: unknown } | null)?.parts;
  const text = Array.isArray(parts)
    ? parts
        .map((part) => (part as { text?: unknown }).text)
        .filter((value): value is string => typeof value === "string")
        .join("")
    : "";
  if (text.trim() === "") {
    return {
      ok: false,
      reason: "no-text",
      detail: typeof finishReason === "string" ? `finishReason=${finishReason}` : "本文が空",
    };
  }

  const totalTokens = body.usageMetadata?.totalTokenCount;
  return {
    ok: true,
    text,
    modelVersion: typeof body.modelVersion === "string" ? body.modelVersion : undefined,
    totalTokens:
      typeof totalTokens === "number" && Number.isFinite(totalTokens) ? totalTokens : undefined,
  };
}

/** 確認問題として受理できなかった理由。 */
export type CheckParseFailure =
  /** 本文が JSON として読めない。 */
  | "not-json"
  /** 2問揃っていない、選択肢の数が違う、文字数の上限を超えている、など。 */
  | "shape"
  /** `answerIndex` が選択肢の範囲外。正解が選択肢に無い。 */
  | "answer-out-of-range"
  /** 同じ選択肢が複数ある。正解が1つに定まらない。 */
  | "duplicate-choices"
  /** 要求した Concept とは別の Concept の問題が返った。 */
  | "concept-mismatch";

export type CheckParseResult =
  { ok: true; check: ConceptCheck } | { ok: false; reason: CheckParseFailure; detail?: string };

/**
 * 1問の形。
 *
 * `v.strictObject` にはしない。指示していないキー（モデルが添える難易度の目安など）が
 * 1つ載っただけで組ごと捨てるのは厳しすぎる。**足りない・違うことは必ず拒否し、
 * 余っていることは無視する**という非対称にしてある。
 */
const questionSchema = v.object({
  prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(CHECK_LIMITS.promptMaxLength)),
  choices: v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(CHECK_LIMITS.choiceMaxLength))),
    // 数を固定する。減っていれば4択として成立せず、増えていれば指示から外れている。
    v.length(CHECK_LIMITS.choiceCount),
  ),
  answerIndex: v.pipe(v.number(), v.integer(), v.minValue(0)),
  explanation: v.pipe(v.string(), v.minLength(1), v.maxLength(CHECK_LIMITS.explanationMaxLength)),
});

const generatedCheckSchema = v.object({
  conceptId: v.pipe(v.string(), v.minLength(1)),
  overview: questionSchema,
  practice: v.object({
    ...questionSchema.entries,
    code: v.pipe(v.string(), v.minLength(1), v.maxLength(CHECK_LIMITS.codeMaxLength)),
  }),
});

/**
 * 生成された本文を {@link ConceptCheck} として読む。
 *
 * `expectedConceptId` は要求した Concept である。応答が別の ID を返したら受理しない。
 * 既知の ID かどうかの判定は入口（`checkPromptInputFor`）で済んでいるので、
 * ここでは要求と応答が一致しているかだけを見る。
 *
 * コードブロックの囲み（```json）は剥がさない。上流へ JSON を要求しているので
 * 囲みは来ず、来たなら形式の逸脱である。黙って剥がすと、契約から外れた応答が
 * 通り続けて、いつ崩れたのかが分からなくなる。
 */
export function parseConceptCheck(text: string, expectedConceptId: ConceptId): CheckParseResult {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (cause) {
    return { ok: false, reason: "not-json", detail: messageOf(cause) };
  }

  const result = v.safeParse(generatedCheckSchema, payload);
  if (!result.success) {
    return { ok: false, reason: "shape", detail: summarizeIssues(result.issues) };
  }
  const generated = result.output;

  if (generated.conceptId !== expectedConceptId) {
    return {
      ok: false,
      reason: "concept-mismatch",
      // 応答が名乗った ID はログと調査に要る。利用者へは出さない（route 側で落とす）。
      detail: `要求 ${expectedConceptId} / 応答 ${generated.conceptId}`,
    };
  }

  for (const [kind, question] of [
    ["overview", generated.overview],
    ["practice", generated.practice],
  ] as const) {
    // 選択肢の数は schema で固定しているが、関係の検査はここで明示する。
    // 数の上限だけに頼ると、選択肢の数を変えたときに範囲の検査が黙って消える。
    if (question.answerIndex >= question.choices.length) {
      return {
        ok: false,
        reason: "answer-out-of-range",
        detail: `${kind}: answerIndex=${String(question.answerIndex)} / choices=${String(question.choices.length)}`,
      };
    }
    const normalized = question.choices.map((choice) => choice.trim());
    if (new Set(normalized).size !== normalized.length) {
      return { ok: false, reason: "duplicate-choices", detail: kind };
    }
  }

  return {
    ok: true,
    check: {
      conceptId: expectedConceptId,
      overview: generated.overview,
      practice: generated.practice,
    },
  };
}

/** 失敗の原因をログ用の1行へ縮める。利用者へは返さない。 */
function summarizeIssues(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`)
    .join("; ");
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
