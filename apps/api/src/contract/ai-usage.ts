/**
 * Managed AI の利用上限と、許可するモデルの契約（Issue #89 / Auth/10）。
 *
 * **政策値の正本は [`docs/ai-limits.md`](../../../../docs/ai-limits.md)
 * である。** このファイルはそこに
 * 書かれた数字を実装へ写したものであり、ここだけを書き換えてはならない。
 * 数字を動かすときは先に ai-limits.md の表を直し、その値をここへ反映する。
 *
 * 上限が無いと何が起きるかは [`docs/auth.md`](../../../../docs/auth.md) §10.1 にある
 * （1ユーザーの日次 約$3,000 / 月 約$91,000）。この契約はその1人月を $1.83 にする。
 */

/**
 * 呼び出しを許可するモデル。
 *
 * allowlist にする理由は、リクエストの `model` が任意の文字列だと、
 * クライアントが単価の高いモデルを名指しできるため（docs/auth.md §10.1）。
 * `gemini-3.5-flash`（入力 $1.50 / 出力 $9.00）を通すと、同じ回数上限のまま
 * 請求だけが約2.4倍になる。**単価を確認していないモデルをここへ足さない。**
 *
 * 単価と確認日は `MODEL_PRICING` にある。
 */
export const ALLOWED_MODELS = ["gemini-3.6-flash", "gemini-3.8-flash"] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

/**
 * 1M tokens あたりの単価（USD）。**確認日: 2026-09-21。**
 * 出典: <https://ai.google.dev/gemini-api/docs/pricing>（有料枠）。
 *
 * **2027-01-01 に倍額になる。** 回数で上限を掛けているため、同じ上限のまま
 * 上限額だけが2倍になる。2026-12 中に ai-limits.md の試算ごと見直すこと。
 *
 * 現時点では請求の計算には使っていない。allowlist へモデルを足すときに、
 * 単価を確認せずに足すことを防ぐために置いてある。
 */
export const MODEL_PRICING: Record<
  AllowedModel,
  { inputPerMillion: number; outputPerMillion: number }
> = {
  "gemini-3.6-flash": { inputPerMillion: 0.75, outputPerMillion: 3.75 },
  "gemini-3.8-flash": { inputPerMillion: 0.75, outputPerMillion: 3.75 },
};

/** 許可したモデルかどうか。 */
export function isAllowedModel(model: string): model is AllowedModel {
  return (ALLOWED_MODELS as readonly string[]).includes(model);
}

/**
 * Managed AI の上限。政策値（docs/ai-limits.md）。
 *
 * 日次を併記するのは、月次だけだと初日に1ヶ月分を使い切られるため。
 * 15回 × 31日 = 465回 で月次（150回）が先に効くので、
 * **日次は瞬間的な暴走を止める役**であり、実質的な上限は月次が持つ。
 */
export const AI_USAGE_LIMITS = {
  /** 暦月（UTC）あたりのリクエスト数。 */
  monthlyRequests: 150,
  /** 1日（UTC）あたりのリクエスト数。 */
  dailyRequests: 15,
  /** 1回の入力上限（tokens）。超過は切り捨てず拒否する。 */
  inputTokensPerRequest: 6_000,
  /** 1回の出力上限（tokens）。`maxTokens` の上限でもある。 */
  outputTokensPerRequest: 2_048,
  /**
   * 暦月（UTC）あたりの累計トークン数。**利用者へ見せない安全弁**である。
   *
   * 月150回 × 1回の上限 8,048 tokens = 1,207,200 が理論上の最大で、
   * その約1.08倍に置いてある。**通常は回数が先に尽きる。**
   * この上限に当たること自体が「1回あたりの想定が外れた」という信号なので、
   * 当たったらログへ残し、政策値を見直す（docs/ai-limits.md）。
   */
  monthlyTokens: 1_300_000,
} as const;

/**
 * 入力の上界を見積もるときに使う、1 token あたりの最小バイト数。
 *
 * Gemini のトークナイザを Worker 上で正確に再現はできない。送信前に拒否する
 * には見積もりが要るので、**実際より少なく数えることが決して無い側**へ倒す。
 *
 * **文字数で数えてはいけない。** `String.length` は UTF-16 のコード単位を返すが、
 * 未知の文字や稀な記号は tokenizer の byte fallback で**1バイトにつき1トークン**
 * まで分解されうる。ひらがな・漢字は1コード単位で UTF-8 3バイト、絵文字や
 * 一部の数学記号は4バイトあるため、文字数で見ると実際の3〜4倍を見落とす。
 * そこを突かれると、1回あたりの単価の上限が崩れ、月額の試算が成り立たなくなる。
 *
 * UTF-8 のバイト数を数え、1バイト = 1トークンを上界とする。実際の
 * トークン化はこれよりはるかに効率が良いので、**この見積もりは常に過大**である。
 * 正確な消費量は応答の `usageMetadata` から取り、蓄積にはそちらを使う。
 */
export const INPUT_BYTES_PER_TOKEN = 1;

/**
 * 送信前の入力トークンの**上界**。実消費ではなく、拒否の判定にだけ使う。
 *
 * 過大に見積もるため、通る入力は必ず実際にも上限内に収まる。
 * 逆に、上限付近の入力が拒否されることはありうる（偽陽性は許容する）。
 * 黙って切り詰めるより、理由を返して利用者に選ばせるほうが良い（RULE-004）。
 */
export function estimateInputTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / INPUT_BYTES_PER_TOKEN);
}

/** 上限に達した理由。利用者への文言と、ログの分類に使う。 */
export type AiUsageLimitKind = "daily" | "monthly" | "tokens";

/**
 * 上限到達時に返す本文。
 *
 * **残量は回数で示す**（docs/ai-limits.md「利用者への見せ方」）。
 * トークンの安全弁に当たった場合も、利用者へは回数と同じ扱いで見せる。
 * 内部の別勘定を利用者へ説明しない。
 */
export interface AiUsageLimitBody {
  error: "ai usage limit reached";
  /** どの上限か。クライアントが文言を選ぶために使う。 */
  limit: AiUsageLimitKind;
  /** 上限が回復する時刻（ISO 8601, UTC）。 */
  resetAt: string;
  /** 利用者へそのまま出せる日本語の説明。 */
  message: string;
}

/** 現在時刻が属する UTC の暦月（`YYYY-MM`）。 */
export function utcMonthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** 現在時刻が属する UTC の日（`YYYY-MM-DD`）。 */
export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** 翌 UTC 0時。日次上限の回復時刻。 */
export function nextUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
}

/** 翌 UTC 月初。月次上限の回復時刻。 */
export function nextUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

/**
 * 利用者が契約しているプラン。**当面 Free のみ**（docs/ai-limits.md
 * 「決定: 当面 Free のみ。Pro は作らない」）。Pro を作るときにここへ足す。
 */
export type Plan = "free";

/** 1つの期間（日次 / 月次）の利用量。回数で示す。 */
export interface AiUsagePeriod {
  used: number;
  limit: number;
  /** この期間の回数が 0 に戻る時刻（ISO 8601, UTC）。 */
  resetAt: string;
}

/**
 * `GET /v1/ai/usage` の本文。Web の「使用状況」「プラン」画面が読む。
 *
 * **トークン数を含めない。** `monthlyTokens` は利用者へ見せない安全弁であり、
 * 残量は回数で示す（docs/ai-limits.md「利用者への見せ方」）。
 */
export interface AiUsageSummary {
  plan: Plan;
  managedAi: {
    daily: AiUsagePeriod;
    monthly: AiUsagePeriod;
  };
}
