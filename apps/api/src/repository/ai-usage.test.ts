import { describe, expect, it } from "vitest";
import { InMemoryAiUsageRepository } from "./ai-usage.js";

/** 上限を気にせず枠を取る（期間の扱いだけを見るテスト向け）。 */
const NO_LIMIT = {
  dailyRequests: Number.MAX_SAFE_INTEGER,
  monthlyRequests: Number.MAX_SAFE_INTEGER,
};

const USER = "auth0|user-a";
const SEPT = { monthKey: "2026-09", dayKey: "2026-09-22" };

describe("InMemoryAiUsageRepository", () => {
  it("記録が無ければ全て 0 を返す", async () => {
    const repo = new InMemoryAiUsageRepository();
    await expect(repo.get({ userId: USER, ...SEPT })).resolves.toEqual({
      monthlyRequests: 0,
      dailyRequests: 0,
      monthlyTokens: 0,
    });
  });

  it("回数を加算し、加算後の値を返す", async () => {
    const repo = new InMemoryAiUsageRepository();
    await repo.reserve({
      userId: USER,
      ...SEPT,
      updatedAt: "2026-09-22T00:00:00.000Z",
      limits: NO_LIMIT,
    });
    const after = await repo.reserve({
      userId: USER,
      ...SEPT,
      updatedAt: "2026-09-22T00:00:01.000Z",
      limits: NO_LIMIT,
    });
    expect(after.reserved).toBe(true);
    expect(after.usage).toMatchObject({ monthlyRequests: 2, dailyRequests: 2 });
  });

  it("日が変わると日次だけが数え直され、月次は積み上がる", async () => {
    const repo = new InMemoryAiUsageRepository();
    await repo.reserve({
      userId: USER,
      ...SEPT,
      updatedAt: "2026-09-22T00:00:00.000Z",
      limits: NO_LIMIT,
    });
    await repo.reserve({
      userId: USER,
      ...SEPT,
      updatedAt: "2026-09-22T00:00:01.000Z",
      limits: NO_LIMIT,
    });

    const nextDay = await repo.reserve({
      userId: USER,
      monthKey: "2026-09",
      dayKey: "2026-09-23",
      updatedAt: "2026-09-23T00:00:00.000Z",
      limits: NO_LIMIT,
    });
    expect(nextDay.usage).toMatchObject({ monthlyRequests: 3, dailyRequests: 1 });
  });

  it("月が変わると回数もトークンも数え直される", async () => {
    const repo = new InMemoryAiUsageRepository();
    await repo.reserve({
      userId: USER,
      ...SEPT,
      updatedAt: "2026-09-22T00:00:00.000Z",
      limits: NO_LIMIT,
    });
    await repo.addTokens({
      userId: USER,
      ...SEPT,
      tokens: 1_000,
      updatedAt: "2026-09-22T00:00:01.000Z",
    });

    await expect(
      repo.get({ userId: USER, monthKey: "2026-10", dayKey: "2026-10-01" }),
    ).resolves.toEqual({ monthlyRequests: 0, dailyRequests: 0, monthlyTokens: 0 });
  });

  it("トークンを当月へ足す", async () => {
    const repo = new InMemoryAiUsageRepository();
    await repo.reserve({
      userId: USER,
      ...SEPT,
      updatedAt: "2026-09-22T00:00:00.000Z",
      limits: NO_LIMIT,
    });
    await repo.addTokens({
      userId: USER,
      ...SEPT,
      tokens: 15,
      updatedAt: "2026-09-22T00:00:01.000Z",
    });
    await repo.addTokens({
      userId: USER,
      ...SEPT,
      tokens: 20,
      updatedAt: "2026-09-22T00:00:02.000Z",
    });

    await expect(repo.get({ userId: USER, ...SEPT })).resolves.toMatchObject({
      monthlyTokens: 35,
      monthlyRequests: 1,
    });
  });

  it("ユーザーごとに独立して数える", async () => {
    const repo = new InMemoryAiUsageRepository();
    await repo.reserve({
      userId: USER,
      ...SEPT,
      updatedAt: "2026-09-22T00:00:00.000Z",
      limits: NO_LIMIT,
    });

    await expect(repo.get({ userId: "auth0|user-b", ...SEPT })).resolves.toMatchObject({
      monthlyRequests: 0,
    });
  });

  it("上限に達していたら枠を確保せず、回数も増やさない", async () => {
    const repo = new InMemoryAiUsageRepository();
    const limits = { dailyRequests: 2, monthlyRequests: 100 };
    await repo.reserve({ userId: USER, ...SEPT, updatedAt: "t", limits });
    await repo.reserve({ userId: USER, ...SEPT, updatedAt: "t", limits });

    const rejected = await repo.reserve({ userId: USER, ...SEPT, updatedAt: "t", limits });

    expect(rejected.reserved).toBe(false);
    // 弾いた分まで枠を消費しない。ここが加算されると、同時リクエストのたびに
    // 月次の枠が減り、通っていない回数まで請求枠を食う。
    expect(rejected.usage.dailyRequests).toBe(2);
    expect(rejected.usage.monthlyRequests).toBe(2);
    await expect(repo.get({ userId: USER, ...SEPT })).resolves.toMatchObject({
      monthlyRequests: 2,
    });
  });
});
