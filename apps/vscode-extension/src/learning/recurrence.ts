/**
 * 同じエラーの再発判定（診断/02 #76）。
 *
 * 一度解説したエラーの識別キー（`context/diagnostics.ts` の `errorKeyOf`）を
 * 時刻と Concept とともに覚えておき、時間窓の内に同じキーが再び解説対象に
 * なったら再発とみなす。VS Code に依存しないため、保存は `store.ts` が担う。
 */

import type { ConceptId } from "@gakushu-sochi/domain";

/**
 * 再発とみなす時間窓。docs/concepts.md の「再発とみなす時間窓」を参照。
 *
 * 無期限にすると、数ヶ月前に一度出したエラーが再発扱いになり、直近の理解を
 * 不当に下げる。
 */
export const RECURRENCE_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;

/** 1件の解説済みエラー。globalState へそのまま保存するため JSON serializable に保つ。 */
export interface ExplainedError {
  /** 最後に解説した時刻。ISO 8601。 */
  explainedAt: string;
  /** そのとき AI が抽出した Concept。 */
  conceptIds: ConceptId[];
}

/** 識別キー → 解説済みエラー。 */
export type ExplainedErrors = Record<string, ExplainedError>;

/** 再発した1件のエラー。 */
export interface RecurredError {
  key: string;
  /** 前回と今回の Concept の和集合。 */
  conceptIds: ConceptId[];
}

function isWithinWindow(explainedAt: string, now: Date): boolean {
  const at = Date.parse(explainedAt);
  // 保存値は isExplainedErrors で検査済み。ここで NaN を 0 へ丸めると
  // 壊れた時刻を「大昔」と黙って読み替えることになるので、例外にする。
  if (Number.isNaN(at)) {
    throw new RangeError(`explainedAt を時刻として解釈できません: ${explainedAt}`);
  }
  const elapsed = now.getTime() - at;
  return elapsed >= 0 && elapsed <= RECURRENCE_WINDOW_MS;
}

/**
 * 今回解説したエラーのうち、時間窓の内に解説済みだったものを返す。
 *
 * Concept は前回と今回の和集合にする。前回の解説で学んだはずの Concept が
 * 定着していなかったことが再発の意味であり、今回の抽出だけに頼ると、
 * モデルがたまたま Concept を返さなかったときに再発が消える。
 */
export function findRecurred(
  explained: ExplainedErrors,
  keys: readonly string[],
  conceptIds: readonly ConceptId[],
  now: Date,
): RecurredError[] {
  return [...new Set(keys)].flatMap((key) => {
    const previous = explained[key];
    if (!previous || !isWithinWindow(previous.explainedAt, now)) {
      return [];
    }
    return [{ key, conceptIds: [...new Set([...previous.conceptIds, ...conceptIds])] }];
  });
}

/**
 * 今回解説したエラーを記録した新しい値を返す。時間窓を過ぎた記録は捨てる。
 *
 * 期限切れを捨てないと、globalState の値が解説したエラーの種類だけ増え続ける。
 */
export function markExplained(
  explained: ExplainedErrors,
  keys: readonly string[],
  conceptIds: readonly ConceptId[],
  now: Date,
): ExplainedErrors {
  const next: ExplainedErrors = {};
  for (const [key, value] of Object.entries(explained)) {
    if (isWithinWindow(value.explainedAt, now)) {
      next[key] = value;
    }
  }
  for (const key of keys) {
    // 窓の内の前回分は残す。今回モデルが Concept を返さなかっただけで、
    // 次の再発をどの Concept へ反映するかが分からなくなるのを防ぐ。
    const previous = next[key]?.conceptIds ?? [];
    next[key] = {
      explainedAt: now.toISOString(),
      conceptIds: [...new Set([...previous, ...conceptIds])],
    };
  }
  return next;
}

/** 保存値が ExplainedErrors として使える形かを検査する。 */
export function isExplainedErrors(value: unknown): value is ExplainedErrors {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const candidate = entry as Partial<ExplainedError>;
    return (
      typeof candidate.explainedAt === "string" &&
      !Number.isNaN(Date.parse(candidate.explainedAt)) &&
      Array.isArray(candidate.conceptIds) &&
      candidate.conceptIds.every((id) => typeof id === "string")
    );
  });
}
