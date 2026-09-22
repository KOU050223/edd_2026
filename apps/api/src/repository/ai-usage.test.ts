import { describe, expect, it } from "vitest";
import { InMemoryAiUsageRepository } from "./ai-usage.js";

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
    await repo.increment({ userId: USER, ...SEPT, updatedAt: "2026-09-22T00:00:00.000Z" });
    const after = await repo.increment({
      userId: USER,
      ...SEPT,
      updatedAt: "2026-09-22T00:00:01.000Z",
    });
    expect(after).toMatchObject({ monthlyRequests: 2, dailyRequests: 2 });
  });

  it("日が変わると日次だけが数え直され、月次は積み上がる", async () => {
    const repo = new InMemoryAiUsageRepository();
    await repo.increment({ userId: USER, ...SEPT, updatedAt: "2026-09-22T00:00:00.000Z" });
    await repo.increment({ userId: USER, ...SEPT, updatedAt: "2026-09-22T00:00:01.000Z" });

    const nextDay = await repo.increment({
      userId: USER,
      monthKey: "2026-09",
      dayKey: "2026-09-23",
      updatedAt: "2026-09-23T00:00:00.000Z",
    });
    expect(nextDay).toMatchObject({ monthlyRequests: 3, dailyRequests: 1 });
  });

  it("月が変わると回数もトークンも数え直される", async () => {
    const repo = new InMemoryAiUsageRepository();
    await repo.increment({ userId: USER, ...SEPT, updatedAt: "2026-09-22T00:00:00.000Z" });
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
    await repo.increment({ userId: USER, ...SEPT, updatedAt: "2026-09-22T00:00:00.000Z" });
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
    await repo.increment({ userId: USER, ...SEPT, updatedAt: "2026-09-22T00:00:00.000Z" });

    await expect(repo.get({ userId: "auth0|user-b", ...SEPT })).resolves.toMatchObject({
      monthlyRequests: 0,
    });
  });
});
