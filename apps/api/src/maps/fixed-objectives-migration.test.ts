import { expect, test } from "vitest";
import { CONCEPTS, isLearningObjectiveIdOf } from "@gakushu-sochi/domain";
import { migratedFixedObjectiveRows } from "./test-fixed-objectives.js";

/**
 * 固定の項目を表へ移したマイグレーション（#245）の中身を確かめる。
 *
 * ID は packages/domain にあったモックと同じにした（モックはこの PR の後に消した）。学習イベントの
 * objective_ids と個人の確認問題の objective_id がこの ID を指している。本番に当てたあとの
 * マイグレーションは書き換えないので、ここでは形と件数を守る。
 */
const rows = migratedFixedObjectiveRows();

test("Go の 20 Concept・88 項目を入れる", () => {
  expect(rows).toHaveLength(88);
  const concepts = new Set(rows.map((row) => row.conceptId));
  expect(concepts.size).toBe(20);
  const known = new Set(CONCEPTS.map((concept) => concept.id));
  for (const conceptId of concepts) {
    expect(conceptId.startsWith("go.")).toBe(true);
    expect(known.has(conceptId)).toBe(true);
  }
});

test("ID は `<Concept ID>:<識別子>` で重ならない", () => {
  for (const row of rows) {
    expect(isLearningObjectiveIdOf(row.id, row.conceptId)).toBe(true);
  }
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  // 理解度の記録が指している ID の例（手で起こしたモックのまま）。
  expect(rows.map((row) => row.id)).toContain("go.defer:lifo_order");
});

test("どのマップにも属さず（map_id が NULL）、出どころは manual", () => {
  for (const row of rows) {
    expect(row.mapId).toBe("NULL");
    expect(row.source).toBe("manual");
  }
});

test("並びは Concept の中で 0 から振る", () => {
  const next = new Map<string, number>();
  for (const row of rows) {
    expect(row.position).toBe(next.get(row.conceptId) ?? 0);
    next.set(row.conceptId, row.position + 1);
  }
});
