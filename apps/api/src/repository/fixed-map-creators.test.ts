import { expect, test } from "vitest";
import sql from "../../migrations/0018_fixed_map_creators.sql?raw";
import { InMemoryFixedMapCreatorRepository } from "./fixed-map-creators.js";

/**
 * 言語別マップの作成者の表の DDL を直接検査する（#245）。インメモリ実装では D1 の制約を再現できない。
 */
const ddl = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

test("作成者は users を CASCADE で参照し、退会で消える", () => {
  expect(ddl).toMatch(/user_id TEXT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
});

test("マイグレーションは作成者の行を入れない（Auth0 の sub を公開リポジトリに書かない）", () => {
  expect(ddl).not.toMatch(/INSERT/i);
});

test("作成者は言語ごと", async () => {
  const creators = new InMemoryFixedMapCreatorRepository();
  creators.add("go", "auth0|a");

  expect(await creators.isCreator("go", "auth0|a")).toBe(true);
  expect(await creators.isCreator("ts", "auth0|a")).toBe(false);
  expect(await creators.isCreator("go", "auth0|b")).toBe(false);
});
