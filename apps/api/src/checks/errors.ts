/** 確認問題の生成が失敗したときに利用者へ返す本文。 */

import {
  type PlanUsageLimits,
  nextUtcDay,
  nextUtcMonth,
  type AiUsageLimitBody,
  type AiUsageLimitKind,
} from "../contract/ai-usage.js";
import type { CheckParseFailure, GeneratedTextFailure } from "./response.js";
import { describeTrace, type UpstreamFailure, type UpstreamTrace } from "./upstream.js";

/** 生成に失敗したことを利用者へ伝える本文。**黙って空の問題を返さない。** */
export interface CheckGenerationErrorBody {
  error: "check generation failed";
  /** 失敗の種別。クライアントが文言を選ぶために使う。 */
  reason: GeneratedTextFailure | CheckParseFailure;
  /** 画面へそのまま出せる説明。上流の応答の断片は載せない。 */
  message: string;
  /**
   * 上流が報告した終了理由（`STOP`・`OTHER` など）。上流の応答が届いたときだけ持つ。
   * 列挙値なので載せてよい。本番のログを見られなくても、空の応答の原因を切り分けられる。
   */
  finishReason?: string;
}

/**
 * 上流の応答は届いたが、問題として使えなかったときの本文。
 *
 * 応答の中身（モデルが返した文字列や検証の詳細）は載せない。ログへは残す。
 * ただし**何が起きたかは伝える**。「失敗しました」だけでは、再試行すれば直るのか、
 * 別の Concept を選ぶべきなのかが分からない。
 */
export function failureBody(
  reason: GeneratedTextFailure | CheckParseFailure,
  finishReason?: string,
): CheckGenerationErrorBody {
  const message = {
    "not-json": "AI の応答を問題として読めませんでした。もう一度お試しください。",
    blocked: "AI が生成を拒否しました。時間をおいて、もう一度お試しください。",
    "no-text": "AI が問題を返しませんでした。もう一度お試しください。",
    truncated: "AI の応答が途中で切れました。もう一度お試しください。",
    shape:
      "AI が作った問題が形式（概要問題と実践問題の2問1組・4択・正解1つ）を満たしていませんでした。" +
      "もう一度お試しください。",
    "answer-out-of-range":
      "AI が作った問題の正解が選択肢に含まれていませんでした。もう一度お試しください。",
    "duplicate-choices":
      "AI が作った問題に同じ選択肢が複数あり、正解が1つに定まりませんでした。もう一度お試しください。",
    "concept-mismatch": "AI が別の概念の問題を返しました。もう一度お試しください。",
  }[reason];
  if (finishReason === undefined) {
    return { error: "check generation failed", reason, message };
  }
  return {
    error: "check generation failed",
    reason,
    message: `${message}（AI の終了理由: ${finishReason}）`,
    finishReason,
  };
}

/**
 * 上限到達時の応答。形は `POST /v1/ai/responses` と同じ（`AiUsageLimitBody`）。
 *
 * 文面だけを変える。AI ルートの文面は Copilot や BYOK を案内するが、Web の確認問題には
 * どちらも無い。保存済みの問題は回数を使わずに解けることを伝える。
 */
export function limitReached(
  kind: AiUsageLimitKind,
  now: Date,
  limits: PlanUsageLimits,
): AiUsageLimitBody {
  const resetAt = kind === "daily" ? nextUtcDay(now) : nextUtcMonth(now);
  const when = kind === "daily" ? "明日 UTC 0時" : "翌月 UTC 1日 0時";
  const scope = kind === "daily" ? "今日" : "今月";
  const allowance =
    kind === "daily"
      ? `${String(limits.dailyRequests)} 回`
      : `${String(limits.monthlyRequests)} 回`;
  return {
    error: "ai usage limit reached",
    limit: kind,
    resetAt: resetAt.toISOString(),
    message:
      `${scope}の AI 利用上限（${allowance}）に達したため、問題を作れません。${when}に回復します。` +
      "作ってある問題は、回数を使わずにそのまま解けます。",
  };
}

/**
 * 上流への呼び出しの失敗を、理由つきで返す本文。
 *
 * どれも同じ「用意できませんでした」にすると、届かなかったのか、時間切れか、
 * Gemini が拒否したのかを、利用者も運営も切り分けられない（#253 の調査で困った）。
 * 本番のログを見られないので、Gemini のエラー本文の要点（状態・文・理由）と
 * 送信の経過を `upstream` に添え、画面の文の末尾にも出す。
 */
export function upstreamFailureBody(
  reason: UpstreamFailure,
  trace: UpstreamTrace,
  status?: number,
) {
  const message = {
    "upstream-timeout":
      "AI の応答が時間内に返りませんでした。時間をおいて、もう一度お試しください。",
    "upstream-unreachable": "AI に接続できませんでした。時間をおいて、もう一度お試しください。",
    "upstream-status": `AI の呼び出しに失敗しました（状態 ${String(status)}）。時間をおいて、もう一度お試しください。`,
    "upstream-unreadable": "AI の応答を読み取れませんでした。もう一度お試しください。",
  }[reason];
  return {
    error: "AI upstream request failed" as const,
    reason,
    ...(status === undefined ? {} : { status }),
    message: `${message}${describeTrace(trace)}`,
    upstream: trace,
  };
}

/** AI の設定漏れ。運営側の障害なので、利用者には再試行では直らないことを伝える。 */
export function notConfiguredBody() {
  return {
    error: "AI service is not configured" as const,
    message:
      "AI の設定に問題があるため、問題を作れません。時間をおいても直らない場合は運営に連絡してください。",
  };
}
