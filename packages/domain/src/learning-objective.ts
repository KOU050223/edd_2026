import { isConceptId, type ConceptId } from "./profile.js";

/**
 * Concept（学習マップのノード）の中で「理解すること」の1項目（設計/05 #224）。
 *
 * 理解度はこの項目ごとに積み上げ（設計/04 #223）、確認問題もこの項目を狙って出す（Web/13 #226）。
 * 本来は Concept の `summary` を入力に AI で生成して保存するが、生成の口はまだ無い。
 * それまでは {@link MOCK_LEARNING_OBJECTIVES} を使う。
 */
export interface LearningObjective {
  /**
   * `<Concept ID>:<項目の識別子>`。例: `go.defer:execution_timing`。
   * 理解度の記録がこの ID を指すので、`label` を書き換えても変えない。
   */
  id: string;
  conceptId: ConceptId;
  /** 表示名。例: `実行タイミング（関数を抜けるとき）` */
  label: string;
}

const LEARNING_OBJECTIVE_KEY_PATTERN = /^[a-z0-9_]+$/;

/** 項目 ID が `<Concept ID>:<識別子>` の形で、指定した Concept に属するか。 */
export function isLearningObjectiveIdOf(value: string, conceptId: ConceptId): boolean {
  const prefix = `${conceptId}:`;
  return (
    isConceptId(conceptId) &&
    value.startsWith(prefix) &&
    LEARNING_OBJECTIVE_KEY_PATTERN.test(value.slice(prefix.length))
  );
}
