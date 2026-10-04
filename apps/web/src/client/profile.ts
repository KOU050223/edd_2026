import type { ConceptFamiliarity } from "@gakushu-sochi/domain";

export interface Concept {
  conceptId: string;
  label?: string;
  status: "confirmed" | "learning" | "unobserved";
  score: number;
  evidence: {
    solvedIndependentlyCount: number;
    /** 直近で観測したイベントの時刻。ISO 8601。現在地の判定に使う。 */
    lastObservedAt?: string;
  };
  /**
   * 「理解すること」の項目 ID をキーにした、項目ごとの理解度（0〜1、設計/04 #223）。
   * 項目を持つ Concept だけに載り、`score` はこの平均になる。
   */
  objectives?: Record<string, number>;
}

/**
 * 外部履歴由来の「触れた形跡」（Issue #157）。
 *
 * API の `learning-profile` 応答の `familiarity` 要素。
 * Mastery（現在理解している）とは別の軸で、Concept の status には混ぜない。
 */
export interface Familiarity extends ConceptFamiliarity {
  label?: string;
}

export function summarizeConcepts<T extends Pick<Concept, "conceptId" | "status">>(
  concepts: readonly T[],
) {
  return concepts.reduce(
    (summary, concept) => ({ ...summary, [concept.status]: summary[concept.status] + 1 }),
    { confirmed: 0, learning: 0, unobserved: 0 },
  );
}
