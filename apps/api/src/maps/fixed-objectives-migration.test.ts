import { expect, test } from "vitest";
import { MOCK_LEARNING_OBJECTIVES } from "@gakushu-sochi/domain";
import sql from "../../migrations/0017_fixed_objectives.sql?raw";

/**
 * 固定の項目を表へ移すマイグレーション（#245）が、モックと同じ ID・表示名・並びで入れることを確かめる。
 *
 * 学習イベントの objective_ids と個人の確認問題の objective_id がこの ID を指している。
 * 1つでも ID が変わると、その項目の理解度が消える。
 */
interface Row {
  id: string;
  conceptId: string;
  mapId: string;
  label: string;
  source: string;
  position: number;
}

/** `(...), (...);` の各行を読む。値は文字列（'' は ' の書き方）・NULL・整数だけ。 */
function rows(): Row[] {
  const values = sql.slice(sql.indexOf("VALUES") + "VALUES".length);
  return [...values.matchAll(/^\s*\((.*)\)[,;]$/gm)].map((match) => {
    const fields = [...match[1]!.matchAll(/'((?:[^']|'')*)'|(NULL)|(\d+)/g)].map(
      ([, text, nil, number]) =>
        text !== undefined ? text.replaceAll("''", "'") : nil !== undefined ? "NULL" : number!,
    );
    const [id, conceptId, mapId, label, source, position] = fields;
    return {
      id: id!,
      conceptId: conceptId!,
      mapId: mapId!,
      label: label!,
      source: source!,
      position: Number(position),
    };
  });
}

test("モックの項目を、同じ ID・Concept・表示名でそのまま入れる", () => {
  expect(rows().map(({ id, conceptId, label }) => ({ id, conceptId, label }))).toEqual(
    MOCK_LEARNING_OBJECTIVES,
  );
});

test("どのマップにも属さず（map_id が NULL）、出どころは manual", () => {
  for (const row of rows()) {
    expect(row.mapId).toBe("NULL");
    expect(row.source).toBe("manual");
  }
});

test("並びは Concept の中で 0 から振る", () => {
  const next = new Map<string, number>();
  for (const row of rows()) {
    expect(row.position).toBe(next.get(row.conceptId) ?? 0);
    next.set(row.conceptId, row.position + 1);
  }
});
