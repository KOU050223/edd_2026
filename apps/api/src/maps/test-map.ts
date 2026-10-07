/**
 * テスト用の手作りマップ（#242）。理解度・確認問題が手で作ったノードを扱うことを確かめるのに使う。
 *
 * マップ `mrust0001`（題名「Rust 入門」）に、前提 → 次の2ノードを置き、
 * 次のノードにだけ「理解すること」を2つ持たせる。
 */

import type { LearningMapRepository } from "../repository/types.js";

export const TEST_MAP_ID = "mrust0001";
export const TEST_MAP_TITLE = "Rust 入門";
/** 前提のノード。項目を持たない。 */
export const TEST_MAP_BASE = { id: `${TEST_MAP_ID}.binding1`, label: "変数の束縛" };
/** 次のノード。項目を持つ。 */
export const TEST_MAP_NODE = {
  id: `${TEST_MAP_ID}.owner001`,
  label: "所有権",
  summary: "値の持ち主は常に1つで、代入や関数呼び出しで持ち主が移る（move）。",
};
export const TEST_MAP_OBJECTIVES = [
  { id: `${TEST_MAP_NODE.id}:move`, label: "代入で持ち主が移る" },
  { id: `${TEST_MAP_NODE.id}:drop`, label: "持ち主がスコープを抜けると解放される" },
];

export async function seedTestMap(maps: LearningMapRepository, userId: string): Promise<void> {
  const nowIso = "2026-09-01T00:00:00.000Z";
  const { created } = await maps.create(userId, {
    id: TEST_MAP_ID,
    content: {
      title: TEST_MAP_TITLE,
      description: "",
      nodes: [
        {
          kind: "own",
          conceptId: TEST_MAP_BASE.id,
          label: TEST_MAP_BASE.label,
          summary: "let で束縛する。",
        },
        {
          kind: "own",
          conceptId: TEST_MAP_NODE.id,
          label: TEST_MAP_NODE.label,
          summary: TEST_MAP_NODE.summary,
        },
      ],
      edges: [{ from: TEST_MAP_BASE.id, to: TEST_MAP_NODE.id }],
    },
    nowIso,
    nowMs: 0,
    maxMaps: 20,
  });
  const saved = await maps.replaceObjectives(userId, {
    mapId: TEST_MAP_ID,
    conceptId: TEST_MAP_NODE.id,
    objectives: TEST_MAP_OBJECTIVES.map((objective) => ({ ...objective, source: "manual" })),
    nowIso,
    nowMs: 0,
  });
  if (!created || !saved) throw new Error("test map could not be seeded");
}
