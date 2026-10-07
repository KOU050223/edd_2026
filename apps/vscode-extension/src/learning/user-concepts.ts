/**
 * 利用者が手で作った学習マップのノード（Issue #242）を、AI へ渡す「既知の概念一覧」と
 * 理解度の導出に使う形へ変える。
 *
 * 取得（`GET /v1/learning-maps:concepts`）は `sync.ts` が行う。ここは応答の検証と変換だけを
 * 持ち、`vscode` に触れないので単体テストできる。
 */

import {
  isConceptId,
  isLearningObjectiveIdOf,
  type Concept,
  type LearningObjective,
  type UserConcepts,
} from "@gakushu-sochi/domain";

/** 応答の1件。apps/api/src/contract/learning-maps.ts の `ClientMapConcept` と対応する。 */
interface MapConceptBody {
  id: string;
  label: string;
  summary: string;
  mapId: string;
  mapTitle: string;
  prerequisites: string[];
  objectives: { id: string; label: string }[];
}

const isString = (value: unknown): value is string => typeof value === "string";

function isMapConceptBody(value: unknown): value is MapConceptBody {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<Record<keyof MapConceptBody, unknown>>;
  return (
    isString(item.id) &&
    isConceptId(item.id) &&
    isString(item.label) &&
    isString(item.summary) &&
    isString(item.mapId) &&
    isString(item.mapTitle) &&
    Array.isArray(item.prerequisites) &&
    item.prerequisites.every(isString) &&
    Array.isArray(item.objectives) &&
    item.objectives.every(
      (objective: unknown) =>
        typeof objective === "object" &&
        objective !== null &&
        isString((objective as { id?: unknown }).id) &&
        isString((objective as { label?: unknown }).label) &&
        isLearningObjectiveIdOf((objective as { id: string }).id, item.id as string),
    )
  );
}

/**
 * 応答を {@link UserConcepts} へ変える。形が契約と違えば `undefined`（呼び出し側が失敗として扱う。
 * 一部だけ捨てて使うと、どのノードが抜けたか分からないまま理解度がずれる。RULE-004）。
 *
 * 表示名にはマップの題名を添える。AI は ID だけでは領域が分からず、同じ名前のノードが
 * 別のマップにあっても見分けられるようにする。
 */
export function toUserConcepts(body: unknown): UserConcepts | undefined {
  const concepts = (body as { concepts?: unknown } | null)?.concepts;
  if (!Array.isArray(concepts) || !concepts.every(isMapConceptBody)) return undefined;
  return {
    concepts: concepts.map((node): Concept => ({
      id: node.id,
      label: `${node.label}（${node.mapTitle}）`,
      // Concept ID のプレフィックス（`<マップの ID>.<識別子>`）と揃える。
      language: node.mapId,
      summary: node.summary,
      prerequisites: node.prerequisites,
      source: { kind: "manual" },
    })),
    objectives: concepts.flatMap((node) =>
      node.objectives.map((objective): LearningObjective => ({
        id: objective.id,
        conceptId: node.id,
        label: objective.label,
      })),
    ),
  };
}
