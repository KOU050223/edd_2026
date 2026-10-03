import { expect, test } from "vitest";
import sql from "../../migrations/0009_concept_checks.sql?raw";

/**
 * concept_checks の DDL を直接検査する（#185）。
 *
 * インメモリ実装では D1 の外部キーを再現できないので、「退会で消えない」の本体は
 * この表が users(id) を参照していないことにある。既存の表（0003 / 0004）に倣って
 * `ON DELETE CASCADE` を付けると、利用者1人の退会で全員分の問題が消える。
 */
test("concept_checks は user_id を持たず、users を参照しない", () => {
  const ddl = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  expect(ddl).toMatch(/CREATE TABLE concept_checks/);
  expect(ddl).toMatch(/concept_id TEXT PRIMARY KEY/);
  expect(ddl).not.toMatch(/user_id/i);
  expect(ddl).not.toMatch(/REFERENCES/i);
});
