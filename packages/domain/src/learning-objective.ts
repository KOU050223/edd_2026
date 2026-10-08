import { isConceptId, type ConceptId } from "./profile.js";

/**
 * Concept（学習マップのノード）の中で「理解すること」の1項目（設計/05 #224）。
 *
 * 理解度はこの項目ごとに積み上げ（設計/04 #223）、確認問題もこの項目を狙って出す（Web/13 #226）。
 * 固定の Concept（言語別マップ）の項目は API の表にあり、その言語のマップの作成者が AI で作り直して
 * 手で直す（#245）。手で作ったマップのノードの項目はマップと一緒に保存する（#242）。
 * クライアントは API から読む。
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

/**
 * 1件の学習イベントに載せられる項目 ID の最大件数。
 *
 * 1回の質問が触れる項目はせいぜい数件で、Concept あたりの項目も 4〜5 件である。
 * 上限が無いと、巨大な配列がそのまま D1 に保存され、読み出しと習熟度の導出のたびに
 * コストを払い続ける。API はこれを超えるイベントを拒否するので、送る側も同じ値で切る。
 */
export const MAX_OBJECTIVE_IDS_PER_EVENT = 64;

const LEARNING_OBJECTIVE_KEY_PATTERN = /^[a-z0-9_]+$/;

/**
 * {@link LearningObjective} の ID の形。`<Concept ID>:<小文字英数とアンダースコア>`。
 * 学習イベントの `objectiveIds` を HTTP 境界で検査するのに使う。
 */
export const LEARNING_OBJECTIVE_ID_PATTERN = /^[a-z0-9]+\.[a-z0-9_]+:[a-z0-9_]+$/;

/** 項目 ID が `<Concept ID>:<識別子>` の形で、指定した Concept に属するか。 */
export function isLearningObjectiveIdOf(value: string, conceptId: ConceptId): boolean {
  const prefix = `${conceptId}:`;
  return (
    isConceptId(conceptId) &&
    value.startsWith(prefix) &&
    LEARNING_OBJECTIVE_KEY_PATTERN.test(value.slice(prefix.length))
  );
}
