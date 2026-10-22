// `history:apply` のうち Electron に依存しない判断（Issue #279 ステップ 3）。
// 除外 Concept の取り出しと Evidence のフィルタ・上限検査を純粋関数にして
// 単体テストできる形にする。
import type { HistoryApplyRequest } from "../../shared/types.js";
import type { LearningEvidence } from "@gakushu-sochi/domain";

/**
 * API の1回あたりの Evidence 上限（apps/api MAX_EVIDENCE_PER_IMPORT）。
 * 超えたまま送ると 400 で握りつぶされるため、理由が分かる形で止める。
 */
export const MAX_EVIDENCE_PER_IMPORT = 5_000;

/** payload の excludeConceptIds から、文字列の Concept ID だけを取り出す。 */
export function parseExcludedConceptIds(payload: HistoryApplyRequest | undefined): Set<string> {
  return new Set(
    Array.isArray(payload?.excludeConceptIds)
      ? payload.excludeConceptIds.filter((id): id is string => typeof id === "string")
      : [],
  );
}

/**
 * プレビューで利用者が外した Concept を Evidence から除き、上限を検査する。
 * すべての Concept が除かれた Evidence は項目ごと落とす。
 */
export function prepareApplyEvidence(
  evidence: readonly LearningEvidence[],
  excluded: ReadonlySet<string>,
): LearningEvidence[] {
  const filtered = evidence
    .map((item) => ({
      ...item,
      conceptIds: item.conceptIds.filter((id) => !excluded.has(id)),
    }))
    .filter((item) => item.conceptIds.length > 0);
  if (filtered.length > MAX_EVIDENCE_PER_IMPORT) {
    throw new Error(
      `取り込む観測が ${MAX_EVIDENCE_PER_IMPORT.toLocaleString()} 件の上限を超えています（${filtered.length.toLocaleString()} 件）。対象のソースを減らすか、Concept を外してから適用してください。`,
    );
  }
  return filtered;
}
