import { describe, expect, test } from "vitest";
import { REPO_MAP_DRAFT_TTL_DAYS, REPO_MAP_LIMITS } from "./repo-maps.js";

describe("リポジトリからのマップの上限（docs/ai-limits.md の写し、#249）", () => {
  test("free は月 3 マップ・作り直し 1 日 5 回・下書き 30 日", () => {
    // 数字を動かすときは docs/ai-limits.md を先に直す。落ちたらこのテストを直すのが実装への反映になる。
    expect(REPO_MAP_LIMITS.free).toEqual({ monthlyDrafts: 3, dailyRebuilds: 5 });
    expect(REPO_MAP_DRAFT_TTL_DAYS).toBe(30);
  });

  test("plus は free 以上（仮の値。docs に仮と書いてある）", () => {
    expect(REPO_MAP_LIMITS.plus.monthlyDrafts).toBeGreaterThan(REPO_MAP_LIMITS.free.monthlyDrafts);
    expect(REPO_MAP_LIMITS.plus.dailyRebuilds).toBeGreaterThan(REPO_MAP_LIMITS.free.dailyRebuilds);
  });
});
