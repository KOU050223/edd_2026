/**
 * 利用者ごとの Concept の一覧（Issue #242）。
 *
 * 固定の一覧（`concepts.md` から生成した {@link CONCEPTS} と、表に入れた固定の「理解すること」）に、
 * その利用者が手で作ったマップのノードと項目を足す。手で作ったノードも Concept として扱い、
 * 理解度の導出・表示名・確認問題の入力に使う（#242「理解度・確認問題・VS Code」）。
 *
 * 参照のノードは元の Concept と同じ ID なので、ここでは足さない（元の側で一覧に入っている）。
 * 分野コンプリートは言語別マップだけを対象にするので、この一覧を使わない。
 */

import { CONCEPTS, type Concept, type LearningObjective } from "@gakushu-sochi/domain";
import { MAX_MAPS_PER_USER, MAX_NODES_PER_MAP } from "../contract/learning-maps.js";
import type { LearningMapRepository } from "../repository/types.js";

export interface UserConceptCatalog {
  /** 固定の Concept のあとに、手で作ったノード（更新の新しいマップから、マップの中は学習の順）。 */
  concepts: readonly Concept[];
  conceptById: ReadonlyMap<string, Concept>;
  /** 固定の項目のあとに、手で作ったノードの項目。 */
  objectives: readonly LearningObjective[];
  /**
   * 領域の表示名。手で作ったノードの `language` はマップの ID なので、マップの題名を返す。
   * 固定の Concept の領域（`go` など）には `undefined` を返す。
   */
  areaLabelOf(language: string): string | undefined;
}

/**
 * 利用者の一覧を読む。
 *
 * @param fixed 固定の Concept の一覧。テストだけが小さな一覧へ差し替える。
 *   固定の項目は `maps` から読む（migrations/0017_fixed_objectives.sql、#245）。
 */
export async function loadUserConceptCatalog(
  maps: LearningMapRepository,
  userId: string,
  fixed: { concepts?: readonly Concept[] } = {},
): Promise<UserConceptCatalog> {
  const [fixedObjectives, nodes] = await Promise.all([
    maps.listFixedObjectives(),
    // 1人が持てるノードの最大数で読む。上限で切ると、古いマップのノードの理解度が消える。
    maps.listOwnNodes(userId, MAX_MAPS_PER_USER * MAX_NODES_PER_MAP),
  ]);
  const mapTitles = new Map(nodes.map((node) => [node.mapId, node.mapTitle]));

  const concepts: Concept[] = [
    ...(fixed.concepts ?? CONCEPTS),
    ...nodes.map((node): Concept => ({
      id: node.conceptId,
      label: node.label,
      // Concept ID のプレフィックス（`<マップの ID>.<識別子>`）と揃える。
      language: node.mapId,
      summary: node.summary,
      prerequisites: node.prerequisites,
      source: { kind: "manual" },
    })),
  ];
  const objectives: LearningObjective[] = [
    ...fixedObjectives,
    ...nodes.flatMap((node) => node.objectives),
  ].map((objective) => ({
    id: objective.id,
    conceptId: objective.conceptId,
    label: objective.label,
  }));

  return {
    concepts,
    conceptById: new Map(concepts.map((concept) => [concept.id, concept])),
    objectives,
    areaLabelOf: (language) => mapTitles.get(language),
  };
}
