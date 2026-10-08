import { expect, test } from "vitest";
import sql from "../../migrations/0016_user_plans.sql?raw";
import { InMemoryUserPlanRepository } from "./user-plans.js";

/**
 * プランの表の DDL を直接検査する（#289）。インメモリ実装では D1 の制約を再現できない。
 */
const ddl = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

test("プランは users を CASCADE で参照し、退会で消える", () => {
  expect(ddl).toMatch(/user_id TEXT PRIMARY KEY REFERENCES users\(id\) ON DELETE CASCADE/);
});

test("プランの値は型（Plan）と同じものだけを受け付ける", () => {
  expect(ddl).toMatch(/CHECK \(plan IN \('free', 'plus'\)\)/);
});

test("行が無い人は free", async () => {
  const plans = new InMemoryUserPlanRepository();
  plans.set("auth0|plus", "plus");

  expect(await plans.get("auth0|someone")).toBe("free");
  expect(await plans.get("auth0|plus")).toBe("plus");
});
