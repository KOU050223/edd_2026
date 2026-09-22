import { describe, expect, it } from "vitest";

import { describeApiFailure, readApiErrorDetail } from "./api-error.js";

describe("readApiErrorDetail", () => {
  it("reads the error field the API returns on failure", () => {
    expect(readApiErrorDetail({ error: "AI service is not configured" })).toBe(
      "AI service is not configured",
    );
  });

  it("ignores a body that carries no usable error", () => {
    for (const body of [
      undefined,
      null,
      "text",
      42,
      {},
      { error: "" },
      { error: "  " },
      { error: 1 },
    ])
      expect(readApiErrorDetail(body)).toBeUndefined();
  });
});

describe("describeApiFailure", () => {
  it("keeps the server's own explanation instead of blaming the URL", () => {
    const message = describeApiFailure(503, { error: "AI service is not configured" });

    // 実際に踏んだ誤診: 鍵の未設定なのに URL とトークンを疑わせていた。
    expect(message).toContain("AI service is not configured");
    expect(message).toContain("GEMINI_API_KEY");
    expect(message).toContain("503");
  });

  it("points at re-login for an authentication failure", () => {
    expect(describeApiFailure(401, { error: "unauthorized" })).toContain("ログインし直して");
  });

  it("distinguishes an upstream failure from a local misconfiguration", () => {
    const upstream = describeApiFailure(502, { error: "AI upstream request failed" });

    expect(upstream).toContain("上流");
    expect(upstream).not.toContain("GEMINI_API_KEY");
  });

  it("says plainly when the server returned no detail", () => {
    const message = describeApiFailure(500, undefined);

    expect(message).toContain("詳細を返しませんでした");
    expect(message).toContain("500");
  });

  it("shows the server's usage-limit guidance instead of a settings hint", () => {
    // 上限到達は設定の誤りではない。「API URL と設定内容を確認してください」と
    // 案内すると、利用者は設定を疑って時間を使う。
    const message = describeApiFailure(429, {
      error: "ai usage limit reached",
      limit: "monthly",
      resetAt: "2026-10-01T00:00:00.000Z",
      message: "今月の AI 利用上限（150 回）に達しました。翌月 UTC 1日 0時に回復します。",
    });

    expect(message).toContain("今月の AI 利用上限");
    expect(message).toContain("回復します");
    expect(message).not.toContain("API URL");
  });

  it("falls back to a waiting hint for a rate limit with no message", () => {
    // 同じ 429 でも、頻度のレート制限は message を持たない。
    // ここで設定を疑わせないよう、待てば直ることを伝える。
    const message = describeApiFailure(429, { error: "too many requests" });

    expect(message).toContain("待って");
    expect(message).not.toContain("API URL");
  });

  it("does not report differing failures with the same text", () => {
    // 同じ文面に潰れると、利用者は次の一手を選べない。
    const seen = [
      describeApiFailure(401, { error: "unauthorized" }),
      describeApiFailure(502, { error: "AI upstream request failed" }),
      describeApiFailure(503, { error: "AI service is not configured" }),
      describeApiFailure(400, { error: "bad request" }),
    ];

    expect(new Set(seen).size).toBe(seen.length);
  });
});
