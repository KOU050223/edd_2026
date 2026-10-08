import { describe, expect, it } from "vitest";
import { PLAN_LIMITS } from "../contract/ai-usage.js";
import { failureBody, limitReached, upstreamFailureBody } from "./errors.js";
import type { UpstreamTrace } from "./upstream.js";

const NOW = new Date("2026-09-26T09:00:00.000Z");

function trace(overrides: Partial<UpstreamTrace> = {}): UpstreamTrace {
  return {
    attempts: 1,
    models: ["gemini-3.8-flash"],
    statuses: [503],
    elapsedMs: 1234,
    ...overrides,
  };
}

describe("failureBody", () => {
  it("終了理由が無ければ、理由ごとの文だけを返す", () => {
    expect(failureBody("shape")).toEqual({
      error: "check generation failed",
      reason: "shape",
      message: expect.stringContaining("2問1組・4択・正解1つ"),
    });
  });

  it("終了理由があれば、文の末尾と本文の両方に添える", () => {
    // 本番のログを見られないので、空の応答の原因は応答本文から切り分ける。
    expect(failureBody("no-text", "MAX_TOKENS")).toEqual({
      error: "check generation failed",
      reason: "no-text",
      message: "AI が問題を返しませんでした。もう一度お試しください。（AI の終了理由: MAX_TOKENS）",
      finishReason: "MAX_TOKENS",
    });
  });
});

describe("limitReached", () => {
  it("日の上限は、翌日 UTC 0時に回復すると伝える", () => {
    const body = limitReached("daily", NOW, PLAN_LIMITS.free);

    expect(body).toMatchObject({
      error: "ai usage limit reached",
      limit: "daily",
      resetAt: "2026-09-27T00:00:00.000Z",
    });
    expect(body.message).toContain(
      `今日の AI 利用上限（${String(PLAN_LIMITS.free.dailyRequests)} 回）`,
    );
    // Web の確認問題には Copilot も BYOK も無い。作ってある問題は解けることを伝える。
    expect(body.message).toContain("作ってある問題は、回数を使わずにそのまま解けます。");
  });

  it("月の上限は、翌月 UTC 1日 0時に回復すると伝える", () => {
    const body = limitReached("monthly", NOW, PLAN_LIMITS.free);

    expect(body).toMatchObject({ limit: "monthly", resetAt: "2026-10-01T00:00:00.000Z" });
    expect(body.message).toContain(
      `今月の AI 利用上限（${String(PLAN_LIMITS.free.monthlyRequests)} 回）`,
    );
  });
});

describe("upstreamFailureBody", () => {
  it("状態コードを文と本文に載せ、経過をそのまま添える", () => {
    const sent = trace({ statuses: [500] });

    expect(upstreamFailureBody("upstream-status", sent, 500)).toEqual({
      error: "AI upstream request failed",
      reason: "upstream-status",
      status: 500,
      message:
        "AI の呼び出しに失敗しました（状態 500）。時間をおいて、もう一度お試しください。" +
        "［詳細: 1 回送信（500）・1.2 秒］",
      upstream: sent,
    });
  });

  it.each([
    ["upstream-timeout", "AI の応答が時間内に返りませんでした。"],
    ["upstream-unreachable", "AI に接続できませんでした。"],
    ["upstream-status", "AI の呼び出しに失敗しました（状態 503）。"],
    ["upstream-unreadable", "AI の応答を読み取れませんでした。"],
  ] as const)("%s は、何が起きたかを文の先頭で伝える", (reason, opening) => {
    const body = upstreamFailureBody(
      reason,
      trace(),
      reason === "upstream-status" ? 503 : undefined,
    );

    expect(body.reason).toBe(reason);
    expect(body.message.startsWith(opening)).toBe(true);
  });

  it("届かなかったときは状態コードを載せず、例外を詳細に出す", () => {
    const body = upstreamFailureBody(
      "upstream-unreachable",
      trace({ statuses: [], cause: "TypeError: network unreachable" }),
    );

    expect(body).not.toHaveProperty("status");
    expect(body.message).toBe(
      "AI に接続できませんでした。時間をおいて、もう一度お試しください。" +
        "［詳細: TypeError: network unreachable・1 回送信・1.2 秒］",
    );
  });

  it("Gemini のエラーの要点を、状態・理由・割り当て・文・再試行の目安の順に並べる", () => {
    // 原因（混雑か割り当て超過か）を本番で切り分けるため（#253）。
    const body = upstreamFailureBody(
      "upstream-status",
      trace({
        statuses: [429],
        upstreamStatus: "RESOURCE_EXHAUSTED",
        upstreamReason: "RATE_LIMIT_EXCEEDED",
        quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
        upstreamMessage: "You exceeded your current quota.",
        retryDelay: "33s",
      }),
      429,
    );

    expect(body.message).toContain(
      "［詳細: RESOURCE_EXHAUSTED / RATE_LIMIT_EXCEEDED / GenerateRequestsPerDayPerProjectPerModel-FreeTier" +
        "・「You exceeded your current quota.」・再試行の目安 33s・1 回送信（429）・1.2 秒］",
    );
  });

  it("モデルを切り替えたときだけ、どのモデルが何を返したかを並べる", () => {
    const switched = upstreamFailureBody(
      "upstream-status",
      trace({
        attempts: 2,
        models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
        statuses: [503, 503],
      }),
      503,
    );
    const single = upstreamFailureBody(
      "upstream-status",
      trace({
        attempts: 2,
        models: ["gemini-3.8-flash", "gemini-3.8-flash"],
        statuses: [503, 503],
      }),
      503,
    );

    expect(switched.message).toContain(
      "2 回送信（gemini-3.8-flash 503, gemini-3.5-flash-lite 503）",
    );
    expect(single.message).toContain("2 回送信（503, 503）");
  });
});
