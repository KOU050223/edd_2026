/**
 * テスト用: マイグレーション 0017 で入れた Go の「理解すること」を読む（#245）。
 *
 * 項目の正本は D1 の表で、packages/domain のモックはもう無い。インメモリのストアの既定は空なので、
 * Go の項目が要るテストはここから入れる。
 */

import sql from "../../migrations/0017_fixed_objectives.sql?raw";
import type { StoredLearningObjective } from "../repository/types.js";

/** マイグレーションの1行。 */
export interface FixedObjectiveRow {
  id: string;
  conceptId: string;
  mapId: string;
  label: string;
  source: string;
  position: number;
}

/** `(...), (...);` の各行を読む。値は文字列（'' は ' の書き方）・NULL・整数だけ。 */
export function migratedFixedObjectiveRows(): FixedObjectiveRow[] {
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

/** マイグレーションで入れた Go の項目（インメモリのストアに入れる形）。 */
export function migratedFixedObjectives(): StoredLearningObjective[] {
  return migratedFixedObjectiveRows().map(({ id, conceptId, label }) => ({
    id,
    conceptId,
    label,
    source: "manual",
  }));
}
