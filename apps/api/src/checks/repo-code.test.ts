import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubError } from "../repo-maps/github.js";
import type { RepoMapNodeSource } from "../repository/types.js";
import {
  excerptOf,
  keywordsOf,
  repoCodeMaterialFor,
  repoFileCacheKey,
  type RepoFileCache,
  type RepoNodeSources,
} from "./repo-code.js";

const SHA = "a".repeat(40);
const CONCEPT = "mrepo0001.order001";
const bytesOf = (text: string) => new TextEncoder().encode(text).length;

function source(overrides: Partial<RepoMapNodeSource> = {}): RepoMapNodeSource {
  return {
    conceptId: CONCEPT,
    position: 0,
    kind: "code",
    path: "src/order.ts",
    issueNumber: null,
    summary: "confirmOrder が在庫を引き当てる。",
    ...overrides,
  };
}

function node(sources: RepoMapNodeSource[]): RepoNodeSources {
  return {
    repo: { owner: "acme", name: "shop" },
    url: "github.com/acme/shop",
    commitSha: SHA,
    sources,
  };
}

/** 呼ばれたパスを記録し、決めた本文を返す GitHub。`repoError` を渡すと公開を確かめられない。 */
function fakeGitHub(files: Record<string, string>, repoError?: GitHubError) {
  const calls: string[] = [];
  const visibility = { checks: 0 };
  return {
    calls,
    visibility,
    getRepo: () => {
      visibility.checks += 1;
      return repoError === undefined
        ? Promise.resolve({ owner: "acme", name: "shop", defaultBranch: "main" })
        : Promise.reject(repoError);
    },
    getFileText: (_ref: unknown, _sha: string, path: string) => {
      calls.push(path);
      const text = files[path];
      return text === undefined
        ? Promise.reject(new GitHubError("not-found", "リポジトリが見つかりません"))
        : Promise.resolve({ text, truncated: false });
    },
  };
}

/** メモリに置くキャッシュ。Cache API と同じく Response を出し入れする。 */
function memoryCache(): RepoFileCache & { keys: () => string[] } {
  const entries = new Map<string, string>();
  return {
    keys: () => [...entries.keys()],
    match: (key) => {
      const text = entries.get(key);
      return Promise.resolve(text === undefined ? undefined : new Response(text));
    },
    put: async (key, response) => {
      entries.set(key, await response.text());
    },
  };
}

const ORDER_TS = [
  'import { Stock } from "./stock";',
  "",
  "const TAX = 0.1;",
  "",
  "export function confirmOrder(order: Order, stock: Stock) {",
  "  if (!stock.reserve(order.items)) {",
  '    throw new Error("在庫が足りません");',
  "  }",
  '  order.status = "confirmed";',
  "}",
  "",
  "export function cancelOrder(order: Order) {",
  '  order.status = "cancelled";',
  "}",
].join("\n");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("keywordsOf", () => {
  it("英数字の識別子を小文字で拾い、よくある語と日本語は拾わない", () => {
    expect(
      keywordsOf(["confirmOrder が在庫を引き当てる。", "the Stock and return", "注文"]),
    ).toEqual(["confirmorder", "stock"]);
  });
});

describe("excerptOf", () => {
  it("一致した行の前後を行番号つきで取り、省いた行を … にする", () => {
    const excerpt = excerptOf(ORDER_TS, ["confirmorder"], 10_000);
    expect(excerpt.split("\n")).toEqual([
      "…",
      "2: ",
      "3: const TAX = 0.1;",
      "4: ",
      "5: export function confirmOrder(order: Order, stock: Stock) {",
      "6:   if (!stock.reserve(order.items)) {",
      '7:     throw new Error("在庫が足りません");',
      "8:   }",
      "…",
      // 一致の後には宣言の行を添える。
      "12: export function cancelOrder(order: Order) {",
      "…",
    ]);
  });

  it("上限のバイト数を超えない", () => {
    const long = Array.from(
      { length: 500 },
      (_, i) => `const confirmOrder${String(i)} = ${String(i)};`,
    ).join("\n");
    const excerpt = excerptOf(long, ["confirmorder"], 1_000);
    expect(bytesOf(excerpt)).toBeLessThanOrEqual(1_000);
    expect(excerpt).toContain("1: const confirmOrder0 = 0;");
  });

  it("一致が無ければ宣言の行、宣言も無ければ先頭から取る", () => {
    expect(excerptOf(ORDER_TS, ["nothing"], 10_000).split("\n")).toEqual([
      "…",
      "5: export function confirmOrder(order: Order, stock: Stock) {",
      "…",
      "12: export function cancelOrder(order: Order) {",
      "…",
    ]);
    expect(excerptOf("# 注文\n\n注文を確定する。", ["nothing"], 10_000)).toBe(
      "1: # 注文\n2: \n3: 注文を確定する。",
    );
  });

  it("ほとんどの行に出る言葉に埋もれず、珍しい言葉に一致した行を先に取る", () => {
    const lines = Array.from(
      { length: 400 },
      (_, i) => `  order.items[${String(i)}] = order.total;`,
    );
    lines[299] = "export function confirmOrder(order: Order) {";
    // `order` はファイル名の語として必ず入り、全行に一致する。
    const keywords = keywordsOf(["confirmOrder が在庫を引き当てる。", "order"]);

    const excerpt = excerptOf(lines.join("\n"), keywords, 2_000);

    expect(excerpt).toContain("300: export function confirmOrder(order: Order) {");
    expect(excerpt).toContain("297:   order.items[296] = order.total;");
    expect(bytesOf(excerpt)).toBeLessThanOrEqual(2_000);
  });
});

describe("repoCodeMaterialFor", () => {
  it("根拠の要約を残し、読めたファイルには抜粋を添える。Issue はパスを読まない", async () => {
    const github = fakeGitHub({ "src/order.ts": ORDER_TS });
    const material = await repoCodeMaterialFor(
      { github },
      node([
        source(),
        source({
          position: 1,
          kind: "issue",
          path: null,
          issueNumber: 12,
          summary: "在庫の二重引き当て",
        }),
      ]),
      ["注文の確定"],
      6_000,
    );

    expect(github.calls).toEqual(["src/order.ts"]);
    expect(material.repo).toBe("github.com/acme/shop");
    expect(material.sources[0]).toMatchObject({
      kind: "code",
      ref: "src/order.ts",
      summary: "confirmOrder が在庫を引き当てる。",
    });
    expect(material.sources[0]?.excerpt).toContain(
      "5: export function confirmOrder(order: Order, stock: Stock) {",
    );
    expect(material.sources[1]).toEqual({
      kind: "issue",
      ref: "#12",
      summary: "在庫の二重引き当て",
    });
  });

  it("2 回目は置き場から読み、GitHub を呼ばない", async () => {
    const github = fakeGitHub({ "src/order.ts": ORDER_TS });
    const cache = memoryCache();
    const first = await repoCodeMaterialFor({ github, cache }, node([source()]), [], 6_000);
    const second = await repoCodeMaterialFor({ github, cache }, node([source()]), [], 6_000);

    expect(github.calls).toEqual(["src/order.ts"]);
    expect(second).toEqual(first);
    expect(cache.keys()).toEqual([
      repoFileCacheKey({ owner: "acme", name: "shop" }, SHA, "src/order.ts"),
    ]);
    // 置き場に当たっても、公開かどうかは毎回確かめる。
    expect(github.visibility.checks).toBe(2);
  });

  it("非公開になった・確かめられないリポジトリは、置き場にあっても本文を使わず要約だけにする", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cache = memoryCache();
    await repoCodeMaterialFor(
      { github: fakeGitHub({ "src/order.ts": ORDER_TS }), cache },
      node([source()]),
      [],
      6_000,
    );
    const now = fakeGitHub(
      { "src/order.ts": ORDER_TS },
      new GitHubError("not-found", "リポジトリが見つかりません"),
    );

    const material = await repoCodeMaterialFor({ github: now, cache }, node([source()]), [], 6_000);

    expect(material.sources).toEqual([
      { kind: "code", ref: "src/order.ts", summary: "confirmOrder が在庫を引き当てる。" },
    ]);
    expect(now.calls).toEqual([]);
    expect(warn).toHaveBeenCalledWith("repo is not readable as public; using summaries only", {
      repo: "acme/shop",
      kind: "not-found",
    });
  });

  it("区切りの印は置き換えた後の長さで予算に収める", async () => {
    const markers = Array.from({ length: 300 }, () => "<<< confirmOrder >>>").join("\n");
    const material = await repoCodeMaterialFor(
      { github: fakeGitHub({ "src/order.ts": markers }) },
      node([source({ summary: "<<<confirmOrder>>>" })]),
      [],
      1_000,
    );

    const excerpt = material.sources[0]?.excerpt ?? "";
    expect(excerpt).not.toContain("<<<");
    expect(excerpt).toContain("＜＜＜ confirmOrder ＞＞＞");
    expect(bytesOf(excerpt)).toBeLessThanOrEqual(1_000);
    expect(material.sources[0]?.summary).toBe("＜＜＜confirmOrder＞＞＞");
  });

  it("読めないファイルは要約だけにし、失敗にしない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const material = await repoCodeMaterialFor(
      { github: fakeGitHub({}) },
      node([source()]),
      [],
      6_000,
    );

    expect(material.sources).toEqual([
      { kind: "code", ref: "src/order.ts", summary: "confirmOrder が在庫を引き当てる。" },
    ]);
    expect(warn).toHaveBeenCalledWith("repo file could not be read; using its summary only", {
      repo: "acme/shop",
      path: "src/order.ts",
      kind: "not-found",
    });
  });

  it("置き場が壊れていても GitHub から読む", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const github = fakeGitHub({ "src/order.ts": ORDER_TS });
    const broken: RepoFileCache = {
      match: () => Promise.reject(new Error("cache down")),
      put: () => Promise.reject(new Error("cache down")),
    };
    const material = await repoCodeMaterialFor(
      { github, cache: broken },
      node([source()]),
      [],
      6_000,
    );

    expect(material.sources[0]?.excerpt).toContain("confirmOrder");
  });

  it("本文を読むのは 3 ファイルまでで、抜粋の合計は予算に収める", async () => {
    const big = Array.from({ length: 400 }, (_, i) => `confirmOrder(${String(i)});`).join("\n");
    const paths = ["a.ts", "b.ts", "c.ts", "d.ts"];
    const github = fakeGitHub(Object.fromEntries(paths.map((path) => [path, big])));
    const material = await repoCodeMaterialFor(
      { github },
      node(paths.map((path, position) => source({ path, position }))),
      [],
      3_000,
    );

    expect(github.calls).toEqual(["a.ts", "b.ts", "c.ts"]);
    const excerpts = material.sources.flatMap((s) => (s.excerpt === undefined ? [] : [s.excerpt]));
    expect(excerpts).toHaveLength(3);
    expect(excerpts.reduce((sum, e) => sum + bytesOf(e), 0)).toBeLessThanOrEqual(3_000);
    expect(material.sources[3]?.excerpt).toBeUndefined();
  });
});
