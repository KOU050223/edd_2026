import { expect, test } from "vitest";
import sql from "../../migrations/0013_learning_maps.sql?raw";

/**
 * 学習マップの DDL を直接検査する（#242）。
 *
 * インメモリ実装では D1 の外部キーを再現できないので、「退会・マップの削除で全部消える」の
 * 本体は、各表が CASCADE で親を参照していることにある。
 */
const ddl = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

function table(name: string): string {
  const match = new RegExp(`CREATE TABLE ${name} \\(([\\s\\S]*?)\\n\\);`).exec(ddl);
  if (match?.[1] === undefined) throw new Error(`table ${name} not found`);
  return match[1];
}

test("マップは users を CASCADE で参照し、退会で消える", () => {
  expect(table("learning_maps")).toMatch(
    /owner_user_id TEXT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/,
  );
});

test("ノード・線・項目は、マップかノードを CASCADE で参照する", () => {
  expect(table("learning_map_nodes")).toMatch(/REFERENCES learning_maps\(id\) ON DELETE CASCADE/);
  const edges = table("learning_map_edges");
  expect(
    edges.match(/REFERENCES learning_map_nodes \(map_id, concept_id\) ON DELETE CASCADE/g),
  ).toHaveLength(2);
  expect(table("learning_objectives")).toMatch(
    /FOREIGN KEY \(map_id, concept_id\)\s+REFERENCES learning_map_nodes \(map_id, concept_id\) ON DELETE CASCADE/,
  );
});

test("参照のノードは表示名・概要を持たず、参照でないノードは必ず持つ", () => {
  const nodes = table("learning_map_nodes");
  expect(nodes).toMatch(/CHECK \(\(is_reference = 1\) = \(label IS NULL\)\)/);
  expect(nodes).toMatch(/CHECK \(\(is_reference = 1\) = \(summary IS NULL\)\)/);
});
