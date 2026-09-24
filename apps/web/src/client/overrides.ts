import type { Concept } from "./profile.js";
import { MASTERY_SCORE_RANGE } from "@gakushu-sochi/domain";
import { MASTERY_STATUSES, type MasteryOverrides, type MasteryStatus } from "../shared/mastery.js";

export { MASTERY_STATUSES };
export type { MasteryOverride, MasteryOverrides, MasteryStatus } from "../shared/mastery.js";

/**
 * 表示中の Concept。自動算出の値はそのまま残し、手動上書きを重ねた結果を持つ。
 *
 * `status` / `score` は上書き後の表示用の値で、`derived` に自動算出の元の値が残る。
 * 「手動で確認済みにしたが、自動算出では学習中」という状態を画面で区別できるようにするため。
 */
export interface OverlaidConcept extends Omit<Concept, "score"> {
  /** 未観測ではスコアを表示しない。 */
  score: number | null;
  /** 手動で上書きされているか。 */
  manual: boolean;
  /** 自動算出のままの値。手動上書きの有無にかかわらず常に元の値。 */
  derived: { status: Concept["status"]; score: number };
}

/**
 * status ごとに `score` が取りうる範囲。
 *
 * `packages/domain` の `MASTERY_SCORE_RANGE` を共有する。
 * status だけ手動で変えて score を自動算出のまま残すと、
 * 「確認済みなのに 45%」のようにバッジとメーターが矛盾した表示になる。
 */
/** 自動算出の score を、手動で選ばれた status と矛盾しない範囲へ収める。 */
export function clampScoreToStatus(score: number, status: MasteryStatus): number | null {
  if (status === "unobserved") return null;
  const range = MASTERY_SCORE_RANGE[status];
  return Math.min(range.max, Math.max(range.min, score));
}

/**
 * 自動算出の Concept 一覧へ手動上書きを重ねる。
 *
 * 上書きは表示だけを変え、`evidence` には一切触れない（Issue #47 完了条件）。
 * 知らない conceptId の上書きが残っていても、Concept を捏造しない。
 */
export function applyOverrides(
  concepts: readonly Concept[],
  overrides: MasteryOverrides,
): OverlaidConcept[] {
  return concepts.map((concept) => {
    const derived = { status: concept.status, score: concept.score };
    const override = overrides[concept.conceptId];
    if (!override)
      return {
        ...concept,
        score: clampScoreToStatus(concept.score, concept.status),
        manual: false,
        derived,
      };
    return {
      ...concept,
      status: override.status,
      score: clampScoreToStatus(concept.score, override.status),
      manual: true,
      derived,
    };
  });
}
