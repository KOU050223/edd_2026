export interface Concept {
  conceptId: string;
  label?: string;
  status: "confirmed" | "learning" | "unobserved";
  score: number;
  evidence: {
    solvedIndependentlyCount: number;
    hintUsedCount: number;
    /** 直近で観測したイベントの時刻。ISO 8601。現在地の判定に使う。 */
    lastObservedAt?: string;
  };
}

export function summarizeConcepts<T extends Pick<Concept, "conceptId" | "status">>(
  concepts: readonly T[],
) {
  return concepts.reduce(
    (summary, concept) => ({ ...summary, [concept.status]: summary[concept.status] + 1 }),
    { confirmed: 0, learning: 0, unobserved: 0 },
  );
}
