import { describe, expect, test } from "vitest";
import { ApiError } from "./api.js";
import { fetchAiUsage, formatResetAt, isAiUsageSummary, toPeriodView } from "./ai-usage.js";

const valid = {
  plan: "free",
  managedAi: {
    daily: { used: 3, limit: 15, resetAt: "2026-09-25T00:00:00.000Z" },
    monthly: { used: 42, limit: 150, resetAt: "2026-10-01T00:00:00.000Z" },
  },
};

describe("isAiUsageSummary", () => {
  test("契約どおりの応答を受け入れる", () => {
    expect(isAiUsageSummary(valid)).toBe(true);
  });

  test("未使用（0 回）の応答を受け入れる", () => {
    expect(
      isAiUsageSummary({
        ...valid,
        managedAi: {
          daily: { ...valid.managedAi.daily, used: 0 },
          monthly: { ...valid.managedAi.monthly, used: 0 },
        },
      }),
    ).toBe(true);
  });

  test.each([
    ["null", null],
    ["知らないプラン", { ...valid, plan: "pro" }],
    ["Object の組み込みプロパティ名のプラン", { ...valid, plan: "toString" }],
    ["managedAi が無い", { plan: "free" }],
    ["月次が無い", { ...valid, managedAi: { daily: valid.managedAi.daily } }],
    [
      "回数が文字列",
      {
        ...valid,
        managedAi: { ...valid.managedAi, daily: { ...valid.managedAi.daily, used: "3" } },
      },
    ],
    [
      "回数が負",
      {
        ...valid,
        managedAi: { ...valid.managedAi, daily: { ...valid.managedAi.daily, used: -1 } },
      },
    ],
    [
      "上限が 0",
      {
        ...valid,
        managedAi: { ...valid.managedAi, monthly: { ...valid.managedAi.monthly, limit: 0 } },
      },
    ],
    [
      "回復時刻が日時として読めない",
      {
        ...valid,
        managedAi: { ...valid.managedAi, daily: { ...valid.managedAi.daily, resetAt: "明日" } },
      },
    ],
  ])("%s なら拒否する", (_, value) => {
    expect(isAiUsageSummary(value)).toBe(false);
  });
});

describe("toPeriodView", () => {
  test("残り回数と割合を計算する", () => {
    expect(toPeriodView(valid.managedAi.monthly)).toEqual({
      used: 42,
      limit: 150,
      remaining: 108,
      percentage: 28,
      resetAt: new Date("2026-10-01T00:00:00.000Z"),
    });
  });

  test("未使用なら残りは上限と同じで、割合は 0", () => {
    const view = toPeriodView({ used: 0, limit: 15, resetAt: "2026-09-25T00:00:00.000Z" });
    expect(view.remaining).toBe(15);
    expect(view.percentage).toBe(0);
  });

  test("上限を超えても残りは 0、割合は 100 に収める", () => {
    const view = toPeriodView({ used: 17, limit: 15, resetAt: "2026-09-25T00:00:00.000Z" });
    expect(view.remaining).toBe(0);
    expect(view.percentage).toBe(100);
  });
});

describe("formatResetAt", () => {
  test("UTC の回復時刻を利用者のタイムゾーンで書く", () => {
    const resetAt = new Date("2026-10-01T00:00:00.000Z");
    expect(formatResetAt(resetAt, "Asia/Tokyo")).toBe("10月1日 09:00");
    // 西側では前日の夜になる。UTC の日付のまま書くと1日ずれて見える。
    expect(formatResetAt(resetAt, "America/Los_Angeles")).toBe("9月30日 17:00");
  });
});

describe("fetchAiUsage", () => {
  test("契約どおりの応答を返す", async () => {
    await expect(fetchAiUsage(async () => Response.json(valid), 0)).resolves.toEqual(valid);
  });

  test("2xx でも契約と違う本文なら失敗として扱う", async () => {
    await expect(fetchAiUsage(async () => Response.json({ plan: "free" }), 0)).rejects.toEqual(
      new ApiError("unavailable"),
    );
  });

  test("利用量の API を呼ぶ", async () => {
    let requested: unknown;
    await fetchAiUsage(async (input) => {
      requested = input;
      return Response.json(valid);
    }, 0);
    expect(requested).toBe("/api/v1/ai/usage");
  });
});
