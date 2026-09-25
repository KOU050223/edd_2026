import { describe, expect, it } from "vitest";
import {
  AI_USAGE_LIMITS,
  ALLOWED_MODELS,
  MODEL_PRICING,
  estimateInputTokens,
  isAllowedModel,
  nextUtcDay,
  nextUtcMonth,
  utcDayKey,
  utcMonthKey,
} from "./ai-usage.js";

describe("モデルの allowlist", () => {
  it("許可したモデルだけを通す", () => {
    expect(isAllowedModel("gemini-3.6-flash")).toBe(true);
    // 既定より単価が高い（入力 $1.50 / 出力 $9.00）。同じ回数上限で約2.4倍になる。
    expect(isAllowedModel("gemini-3.5-flash")).toBe(false);
    expect(isAllowedModel("")).toBe(false);
  });

  it("許可したモデルには単価が記録されている", () => {
    // 単価を確認せずに allowlist へ足すと、上限額の試算が意味を失う。
    for (const model of ALLOWED_MODELS) {
      expect(MODEL_PRICING[model].inputPerMillion).toBeGreaterThan(0);
      expect(MODEL_PRICING[model].outputPerMillion).toBeGreaterThan(0);
    }
  });
});

describe("上限値（docs/ai-limits.md の写し）", () => {
  it("政策値が正本と一致する", () => {
    // 数字を動かすときは docs/ai-limits.md を先に直す。
    expect(AI_USAGE_LIMITS).toEqual({
      monthlyRequests: 150,
      dailyRequests: 15,
      inputTokensPerRequest: 6_000,
      outputTokensPerRequest: 2_048,
      monthlyTokens: 1_300_000,
    });
  });

  it("日次より月次が先に効く", () => {
    // 15回 × 31日 = 465回 なので、日次は瞬間的な暴走を止める役である。
    expect(AI_USAGE_LIMITS.dailyRequests * 31).toBeGreaterThan(AI_USAGE_LIMITS.monthlyRequests);
  });

  it("トークンの安全弁は回数上限の理論最大より上にある", () => {
    // 通常は回数が先に尽きる。当たること自体が「想定が外れた」信号になる。
    const theoreticalMax =
      AI_USAGE_LIMITS.monthlyRequests *
      (AI_USAGE_LIMITS.inputTokensPerRequest + AI_USAGE_LIMITS.outputTokensPerRequest);
    expect(AI_USAGE_LIMITS.monthlyTokens).toBeGreaterThan(theoreticalMax);
  });
});

describe("入力トークンの見積もり", () => {
  it("実際より多めに数える側へ倒す", () => {
    // 正確な再現はできないので、拒否の判定では過小評価しない。
    expect(estimateInputTokens("あいうえお")).toBeGreaterThanOrEqual(5);
    expect(estimateInputTokens("")).toBe(0);
  });

  it("文字数ではなく UTF-8 のバイト数で数える", () => {
    // `String.length` は UTF-16 のコード単位なので、日本語は1文字=1になる。
    // それを上界にすると、byte fallback で1バイト=1トークンまで分解される
    // 入力を実際の3分の1に見積もり、1回あたりの単価の上限が崩れる。
    expect("あ".length).toBe(1);
    expect(estimateInputTokens("あ")).toBe(3);
  });

  it("サロゲートペアを含む文字を過小評価しない", () => {
    // 絵文字は UTF-16 で2コード単位・UTF-8 で4バイト。
    expect(estimateInputTokens("😀")).toBe(4);
    // 数学記号も同様に4バイトある。
    expect(estimateInputTokens("𝕏")).toBe(4);
  });

  it("ASCII は1文字1トークンのまま", () => {
    expect(estimateInputTokens("const answer = 42")).toBe(17);
  });
});

describe("期間のキーと回復時刻（UTC）", () => {
  it("暦月と日を UTC で切る", () => {
    const now = new Date("2026-09-22T23:59:59.999Z");
    expect(utcMonthKey(now)).toBe("2026-09");
    expect(utcDayKey(now)).toBe("2026-09-22");
  });

  it("日次は翌 UTC 0時に回復する", () => {
    expect(nextUtcDay(new Date("2026-09-22T10:00:00.000Z")).toISOString()).toBe(
      "2026-09-23T00:00:00.000Z",
    );
  });

  it("月末をまたぐ日次の回復が翌月1日になる", () => {
    expect(nextUtcDay(new Date("2026-09-30T23:00:00.000Z")).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("月次は翌月1日 UTC 0時に回復する", () => {
    expect(nextUtcMonth(new Date("2026-09-22T10:00:00.000Z")).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("年末をまたぐ月次の回復が翌年1月になる", () => {
    expect(nextUtcMonth(new Date("2026-12-15T10:00:00.000Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});
