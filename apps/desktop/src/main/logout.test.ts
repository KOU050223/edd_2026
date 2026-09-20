import { describe, expect, it, vi } from "vitest";

import { performLogout, type LogoutDeps } from "./logout.js";

/**
 * 呼び出しの順序を記録する組。
 *
 * ログアウトの不変条件は「ローカルの破棄が先、撤回が後」なので、
 * どちらが呼ばれたかではなく**どの順で呼ばれたか**を見る（docs/auth.md §8）。
 */
function buildDeps(options: { stored?: string | undefined; revokeFails?: boolean } = {}) {
  const calls: string[] = [];
  let stored = "stored" in options ? options.stored : "refresh-token-value";
  const errors: string[] = [];

  const deps: LogoutDeps = {
    readRefreshToken: () => stored,
    clearRefreshToken: () => {
      calls.push("clear");
      stored = undefined;
    },
    revoke: () => {
      calls.push("revoke");
      return options.revokeFails
        ? Promise.reject(new Error("revocation failed"))
        : Promise.resolve();
    },
    notify: () => calls.push("notify"),
    logError: (message) => errors.push(message),
  };

  return { deps, calls, errors, storedNow: () => stored };
}

describe("performLogout", () => {
  it("clears the local refresh token before revoking it", async () => {
    const { deps, calls } = buildDeps();

    await performLogout(deps);

    // 破棄が撤回より前。逆だと、撤回の通信で失敗したときにローカルへ
    // トークンが残り、ログアウトしたつもりの端末がログイン済みのままになる。
    expect(calls.indexOf("clear")).toBeLessThan(calls.indexOf("revoke"));
    expect(calls).toEqual(["clear", "notify", "revoke"]);
  });

  it("keeps the local token destroyed when the revocation fails", async () => {
    const { deps, calls, errors, storedNow } = buildDeps({ revokeFails: true });

    // 撤回が失敗しても例外にしない。利用者から見たログアウトは成立している。
    await expect(performLogout(deps)).resolves.toBeUndefined();

    expect(calls).toEqual(["clear", "notify", "revoke"]);
    expect(storedNow()).toBeUndefined();
    // 握りつぶさず記録する（.agents/rules/rules.md RULE-004）。
    expect(errors).toEqual(["failed to revoke the refresh token after local logout"]);
  });

  it("tells the renderer it is logged out even when the revocation fails", async () => {
    const { deps, calls } = buildDeps({ revokeFails: true });

    await performLogout(deps);

    // 通知も撤回より前。撤回の結果を待ってから伝えると、失敗時に画面が
    // 「ログイン済み」のまま固まる。
    expect(calls.indexOf("notify")).toBeLessThan(calls.indexOf("revoke"));
  });

  it("does not call the revocation endpoint when nothing is stored", async () => {
    const { deps, calls } = buildDeps({ stored: undefined });

    await performLogout(deps);

    expect(calls).toEqual(["clear", "notify"]);
    expect(calls).not.toContain("revoke");
  });

  it("revokes the token that was stored before it was cleared", async () => {
    // 破棄を先に行うので、撤回へ渡す値は読み出し済みのものでなければならない。
    // 破棄後に読み直す実装だと undefined を撤回しに行く。
    const revoke = vi.fn(() => Promise.resolve());
    let stored: string | undefined = "refresh-token-value";

    await performLogout({
      readRefreshToken: () => stored,
      clearRefreshToken: () => {
        stored = undefined;
      },
      revoke,
      notify: () => {},
      logError: () => {},
    });

    expect(revoke).toHaveBeenCalledWith("refresh-token-value");
  });
});
