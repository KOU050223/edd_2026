import { describe, expect, it } from "vitest";

// @ts-expect-error -- renderer は素の JS。markdown.test.ts と同じ読み方をする。
import { AUTH_LABELS, authStatusLabel, shouldApplyAuthState } from "./auth-status.js";

describe("authStatusLabel", () => {
  it("shows the stored login state when idle", () => {
    expect(authStatusLabel({ loggingIn: false, hasRefreshToken: true })).toBe(AUTH_LABELS.loggedIn);
    expect(authStatusLabel({ loggingIn: false, hasRefreshToken: false })).toBe(
      AUTH_LABELS.loggedOut,
    );
  });

  it("keeps showing progress while a login is in flight", () => {
    // 進行中の表示が、保存済みトークンの有無に上書きされないこと。
    expect(authStatusLabel({ loggingIn: true, hasRefreshToken: false })).toBe(
      AUTH_LABELS.loggingIn,
    );
    expect(authStatusLabel({ loggingIn: true, hasRefreshToken: true })).toBe(AUTH_LABELS.loggingIn);
  });
});

describe("shouldApplyAuthState", () => {
  it("applies a pushed state when no login is running", () => {
    expect(shouldApplyAuthState({ loggingIn: false, hasRefreshToken: false })).toBe(true);
  });

  it("ignores a pushed state while a login is running", () => {
    // invalid_grant の通知がログイン中に届いても「未ログイン」へ戻さない。
    expect(shouldApplyAuthState({ loggingIn: true, hasRefreshToken: false })).toBe(false);
  });
});
