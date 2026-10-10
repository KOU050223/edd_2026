import { describe, expect, test } from "vitest";
import { createGitHubClient, GitHubError, type GitHubErrorKind } from "./github.js";

const ref = { owner: "o", name: "r" };
const SHA = "b".repeat(40);

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** 呼ばれた URL とヘッダを記録して、決めた応答を返す fetch。 */
function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url);
  }) as typeof fetch;
  return { fn, calls };
}

async function kindOf(promise: Promise<unknown>): Promise<GitHubErrorKind> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof GitHubError) return e.kind;
    throw e;
  }
  throw new Error("失敗するはずの呼び出しが成功した");
}

function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

describe("リクエスト", () => {
  test("トークンを載せ、リダイレクトを追わず、期限を付ける", async () => {
    const f = fakeFetch(() => json({ default_branch: "main", private: false }));
    const client = createGitHubClient({ token: "tkn", fetchFn: f.fn });
    await expect(client.getRepo(ref)).resolves.toEqual({ defaultBranch: "main" });
    const init = f.calls[0]?.init;
    expect(f.calls[0]?.url).toBe("https://api.github.com/repos/o/r");
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tkn");
  });

  test("トークンが無ければ Authorization を付けない", async () => {
    const f = fakeFetch(() => json({ default_branch: "main", private: false }));
    await createGitHubClient({ token: undefined, fetchFn: f.fn }).getRepo(ref);
    expect((f.calls[0]?.init?.headers as Record<string, string>).authorization).toBeUndefined();
  });
});

describe("失敗の種類", () => {
  const cases: [string, () => Response, GitHubErrorKind][] = [
    ["404", () => new Response("", { status: 404 }), "not-found"],
    ["403（権限なし）", () => new Response("", { status: 403 }), "not-found"],
    ["451", () => new Response("", { status: 451 }), "not-found"],
    [
      "403（上限）",
      () => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
      "rate-limited",
    ],
    ["429", () => new Response("", { status: 429 }), "rate-limited"],
    ["301（移動）", () => new Response("", { status: 301 }), "moved"],
    ["500", () => new Response("", { status: 500 }), "unavailable"],
    ["200 だが JSON でない", () => new Response("<html>", { status: 200 }), "unreadable"],
  ];
  test.each(cases)("%s", async (_name, make, kind) => {
    const f = fakeFetch(make);
    const client = createGitHubClient({ token: "t", fetchFn: f.fn });
    await expect(kindOf(client.getRepo(ref))).resolves.toBe(kind);
  });

  test("接続できない・時間切れは区別する", async () => {
    const down = createGitHubClient({
      token: "t",
      fetchFn: (async () => {
        throw new TypeError("network");
      }) as typeof fetch,
    });
    await expect(kindOf(down.getRepo(ref))).resolves.toBe("unreachable");

    const slow = createGitHubClient({
      token: "t",
      timeoutMs: 5,
      fetchFn: ((_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })) as typeof fetch,
    });
    await expect(kindOf(slow.getRepo(ref))).resolves.toBe("timeout");
  });

  test("非公開のリポジトリは存在しないのと同じに扱う", async () => {
    const f = fakeFetch(() => json({ default_branch: "main", private: true }));
    const client = createGitHubClient({ token: "t", fetchFn: f.fn });
    await expect(kindOf(client.getRepo(ref))).resolves.toBe("not-found");
  });

  test("形が違う応答は失敗にする", async () => {
    const f = fakeFetch(() => json({ nope: true }));
    const client = createGitHubClient({ token: "t", fetchFn: f.fn });
    await expect(kindOf(client.getRepo(ref))).resolves.toBe("unreadable");
    await expect(kindOf(client.getHeadSha(ref, "main"))).resolves.toBe("unreadable");
    await expect(kindOf(client.getTree(ref, SHA))).resolves.toBe("unreadable");
  });
});

describe("ツリー・commit", () => {
  test("commit SHA を返す。ブランチ名は符号化する", async () => {
    const f = fakeFetch(() => json({ sha: SHA }));
    const client = createGitHubClient({ token: "t", fetchFn: f.fn });
    await expect(client.getHeadSha(ref, "feat/x")).resolves.toBe(SHA);
    expect(f.calls[0]?.url).toBe("https://api.github.com/repos/o/r/commits/feat%2Fx");
  });

  test("ツリーが切り詰められたら失敗にする", async () => {
    const f = fakeFetch(() => json({ tree: [], truncated: true }));
    const client = createGitHubClient({ token: "t", fetchFn: f.fn });
    await expect(kindOf(client.getTree(ref, SHA))).resolves.toBe("too-large");
  });

  test("path・type・sha・size を読む", async () => {
    const f = fakeFetch(() =>
      json({
        tree: [
          { path: "a.md", type: "blob", sha: "1", size: 10 },
          { path: "d", type: "tree", sha: "2" },
        ],
        truncated: false,
      }),
    );
    const client = createGitHubClient({ token: "t", fetchFn: f.fn });
    await expect(client.getTree(ref, SHA)).resolves.toEqual([
      { path: "a.md", type: "blob", sha: "1", size: 10 },
      { path: "d", type: "tree", sha: "2" },
    ]);
  });
});

describe("ファイルの本文", () => {
  const blob = (text: string) =>
    fakeFetch(() =>
      json({ encoding: "base64", content: b64(text), size: new TextEncoder().encode(text).length }),
    );

  test("上限以内なら全部読む", async () => {
    const client = createGitHubClient({ token: "t", fetchFn: blob("# 注文\n").fn });
    await expect(client.getBlobText(ref, "s", 1000)).resolves.toMatchObject({
      text: "# 注文\n",
      truncated: false,
    });
  });

  test("上限で切り、多バイト文字の途中で終わっても壊れた文字を残さない", async () => {
    const client = createGitHubClient({ token: "t", fetchFn: blob("あいう").fn });
    // 「あ」は 3 バイト。4 バイトで切ると「あ」+ 壊れた 1 バイト。
    const result = await client.getBlobText(ref, "s", 4);
    expect(result.text).toBe("あ");
    expect(result.truncated).toBe(true);
    expect(result.size).toBe(9);
  });

  test("バイナリ（NUL を含む）は失敗にする", async () => {
    const f = fakeFetch(() => json({ encoding: "base64", content: btoa("a\0b"), size: 3 }));
    const client = createGitHubClient({ token: "t", fetchFn: f.fn });
    await expect(kindOf(client.getBlobText(ref, "s", 100))).resolves.toBe("unreadable");
  });

  test("base64 でない・壊れた本文は失敗にする", async () => {
    const f = fakeFetch(() => json({ encoding: "base64", content: "***", size: 3 }));
    const client = createGitHubClient({ token: "t", fetchFn: f.fn });
    await expect(kindOf(client.getBlobText(ref, "s", 100))).resolves.toBe("unreadable");
  });
});

describe("Issue", () => {
  const raw = (n: number, extra: Record<string, unknown> = {}) => ({
    number: n,
    title: `t${n}`,
    state: "open",
    updated_at: "2026-10-10T00:00:00Z",
    labels: [{ name: "bug" }, "docs"],
    body: "本文",
    ...extra,
  });

  test("一覧は PR を除いて、件数で打ち切る", async () => {
    const f = fakeFetch(() => json([raw(5, { pull_request: {} }), raw(4), raw(3), raw(2)]));
    const client = createGitHubClient({ token: "t", fetchFn: f.fn });
    const issues = await client.listIssues(ref, 2);
    expect(issues.map((i) => i.number)).toEqual([4, 3]);
    expect(issues[0]).toEqual({
      number: 4,
      title: "t4",
      state: "open",
      labels: ["bug", "docs"],
      updatedAt: "2026-10-10T00:00:00Z",
    });
    expect(f.calls[0]?.url).toContain("state=all&sort=updated&direction=desc");
  });

  test("1 件は PR かどうかを返す", async () => {
    const f = fakeFetch(() => json(raw(7, { pull_request: { url: "x" } })));
    const client = createGitHubClient({ token: "t", fetchFn: f.fn });
    await expect(client.getIssue(ref, 7)).resolves.toMatchObject({
      number: 7,
      isPullRequest: true,
    });
  });

  test("形が違う Issue は失敗にする", async () => {
    const f = fakeFetch(() => json([{ number: "x" }]));
    const client = createGitHubClient({ token: "t", fetchFn: f.fn });
    await expect(kindOf(client.listIssues(ref, 5))).resolves.toBe("unreadable");
  });
});
