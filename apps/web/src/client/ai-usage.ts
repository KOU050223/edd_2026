/**
 * `GET /api/v1/ai/usage` の契約と、画面に出す値の計算（Issue #165）。
 *
 * 描画から切り離してあるのは、jsdom が無くても検証できるようにするため
 * （apps/web/AGENTS.md）。上限の数字はここに持たない。政策値の正本は
 * API 側にあり、画面へ写すと値を動かしたときに画面だけが古い上限を示す。
 */

import { ApiError, requestJson } from "./api.js";

export const AI_USAGE_PATH = "/api/v1/ai/usage";

/** 当面 Free のみ（docs/architecture.md「決定: 当面 Free のみ。Pro は作らない」）。 */
export type Plan = "free";

export interface AiUsagePeriod {
  used: number;
  limit: number;
  /** 回数が 0 に戻る時刻（ISO 8601, UTC）。 */
  resetAt: string;
}

export interface AiUsageSummary {
  plan: Plan;
  managedAi: { daily: AiUsagePeriod; monthly: AiUsagePeriod };
}

/** 画面に出すプランの名前と価格。価格は実装済みのプランのものだけを書く。 */
export const PLAN_LABELS: Record<Plan, { name: string; price: string }> = {
  free: { name: "Free", price: "¥0 / 月" },
};

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPeriod(value: unknown): value is AiUsagePeriod {
  if (typeof value !== "object" || value === null) return false;
  const period = value as Record<string, unknown>;
  return (
    isCount(period.used) &&
    isCount(period.limit) &&
    // 上限 0 は割り算が壊れるうえ、契約上ありえない。受け取った時点で弾く。
    period.limit > 0 &&
    typeof period.resetAt === "string" &&
    !Number.isNaN(Date.parse(period.resetAt))
  );
}

/**
 * 応答が契約どおりかを確かめる。2xx でも中身が違えば失敗として扱う（RULE-004）。
 * 知らないプランを Free として表示しない。
 */
export function isAiUsageSummary(value: unknown): value is AiUsageSummary {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Record<string, unknown>;
  if (!Object.hasOwn(PLAN_LABELS, summary.plan as string)) return false;
  const managedAi = summary.managedAi;
  if (typeof managedAi !== "object" || managedAi === null) return false;
  const { daily, monthly } = managedAi as Record<string, unknown>;
  return isPeriod(daily) && isPeriod(monthly);
}

/**
 * 利用量を取得する。「使用状況」と「プラン」の両方の loader が使う。
 *
 * 2xx でも中身が契約どおりでなければ失敗として扱う（RULE-004）。
 */
export async function fetchAiUsage(
  fetcher: typeof fetch,
  sessionRetries: number,
): Promise<AiUsageSummary> {
  const usage = await requestJson<unknown>(AI_USAGE_PATH, fetcher, sessionRetries);
  if (!isAiUsageSummary(usage)) throw new ApiError("unavailable");
  return usage;
}

export interface PeriodView {
  used: number;
  limit: number;
  remaining: number;
  /** progress bar の幅。0〜100 に収める。 */
  percentage: number;
  resetAt: Date;
}

/**
 * 表示用の値へ変換する。
 *
 * 上限を超えた値が来ても画面を壊さないよう、残りは 0 未満に、割合は 100 超に
 * しない。枠の確保は上限で止まるが、政策値を月の途中で下げれば超過した値が返る。
 */
export function toPeriodView(period: AiUsagePeriod): PeriodView {
  return {
    used: period.used,
    limit: period.limit,
    remaining: Math.max(0, period.limit - period.used),
    percentage: Math.min(100, (period.used * 100) / period.limit),
    resetAt: new Date(period.resetAt),
  };
}

/**
 * 回復時刻を利用者のローカル時刻で書く。サーバーの集計単位は UTC だが、
 * 「UTC 0時」と書かれても利用者はいつ使えるようになるのか分からない。
 *
 * `timeZone` はテストのためだけにある。画面では渡さず、ブラウザの設定に従う。
 */
export function formatResetAt(resetAt: Date, timeZone?: string): string {
  return resetAt.toLocaleString("ja-JP", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
}
