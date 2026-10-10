import { describe, expect, test } from "vitest";
import {
  analyzeTree,
  classify,
  codeScore,
  compressListing,
  detectMonorepo,
  filterByFolders,
  MAX_FILE_BYTES,
  validateTargets,
} from "./classify.js";
import type { TreeEntry } from "./github.js";

let seq = 0;
const blob = (path: string, size = 1000, sha?: string): TreeEntry => ({
  path,
  type: "blob",
  sha: sha ?? `sha${seq++}`,
  size,
});
const dir = (path: string): TreeEntry => ({ path, type: "tree", sha: `d${seq++}` });

describe("classify", () => {
  test.each([
    ["GLOSSARY.md", "glossary"],
    ["docs/ubiquitous-language.md", "glossary"],
    ["db/schema.rb", "schema"],
    ["prisma/schema.prisma", "schema"],
    ["api/openapi.yaml", "schema"],
    ["README.md", "doc"],
    ["packages/a/README.md", "doc"],
    ["docs/design/order.md", "doc"],
    ["docs/notes.txt", "doc"],
    ["notes.txt", "other"],
    ["app/models/order.rb", "code"],
    ["src/main.go", "code"],
    ["CLAUDE.md", "other"],
    [".github/pull_request_template.md", "other"],
    ["assets/logo.png", "other"],
  ])("%s は %s", (path, cls) => {
    expect(classify(path)).toBe(cls);
  });
});

describe("codeScore", () => {
  test("ドメインに近いほど高く、テスト・設定は低い", () => {
    expect(codeScore("app/models/order.rb")).toBeGreaterThan(codeScore("app/helpers/x.rb"));
    expect(codeScore("src/domain/order.ts")).toBeGreaterThan(codeScore("src/domain/order.test.ts"));
    expect(codeScore("vite.config.ts")).toBeLessThan(0);
    expect(codeScore("a/b/c/d/e/f/g.ts")).toBeLessThan(codeScore("a/g.ts"));
  });
});

describe("analyzeTree", () => {
  test("文書は残し、依存・生成・ロック・バイナリ・大きなコードを理由つきで捨てる", () => {
    const { kept, dropped, blobTotal } = analyzeTree([
      dir("src"),
      blob("README.md"),
      blob("docs/spec.md", MAX_FILE_BYTES * 5),
      blob("node_modules/x/README.md"),
      blob("src/order.ts"),
      blob("dist/bundle.js"),
      blob("package-lock.json"),
      blob("assets/a.png"),
      blob("src/huge.ts", MAX_FILE_BYTES + 1),
      blob("docs/design.pdf"),
    ]);
    expect(kept.map((f) => f.path)).toEqual(["README.md", "docs/spec.md", "src/order.ts"]);
    expect(dropped).toEqual({
      dependency_dir: 2,
      lock_or_generated: 1,
      binary: 1,
      too_large: 1,
      unreadable_doc: 1,
    });
    expect(blobTotal).toBe(9);
  });

  test("同じ内容の文書・コードは 1 つにする", () => {
    const { kept, dropped } = analyzeTree([
      blob("README.md", 10, "same"),
      blob("docs/README.md", 10, "same"),
    ]);
    expect(kept).toHaveLength(1);
    expect(dropped).toEqual({ duplicate: 1 });
  });

  test("指定したファイルは捨てる規則を通さないが、サイズの上限は効く", () => {
    const entries = [
      blob("dist/order.js", 500),
      blob("vendor/lib/big.rb", MAX_FILE_BYTES + 1),
      blob("src/other.ts"),
    ];
    const { kept, dropped } = analyzeTree(entries, new Set(["dist/order.js", "vendor/lib/big.rb"]));
    expect(kept.map((f) => [f.path, f.pinned])).toEqual([
      ["dist/order.js", true],
      ["src/other.ts", false],
    ]);
    expect(dropped).toEqual({ too_large: 1 });
  });

  test("同じ入力なら結果が同じ", () => {
    const entries = [blob("a.ts", 400, "1"), blob("b.ts", 400, "2"), blob("README.md", 9, "3")];
    expect(analyzeTree(entries)).toEqual(analyzeTree(entries));
  });
});

describe("filterByFolders", () => {
  const entries = [
    blob("apps/web/a.ts"),
    blob("apps/api/b.ts"),
    blob("apps/webx/c.ts"),
    blob("x.md"),
  ];
  test("空なら全体", () => {
    expect(filterByFolders(entries, [])).toHaveLength(4);
  });
  test("選んだフォルダの下だけ（名前の前方一致で混ざらない）", () => {
    expect(filterByFolders(entries, ["apps/web"]).map((e) => e.path)).toEqual(["apps/web/a.ts"]);
  });
});

describe("compressListing", () => {
  test("予算を超えず、入りきらない分は件数だけ書く", () => {
    const entries: TreeEntry[] = [blob("README.md", 500), blob("GLOSSARY.md", 300)];
    for (let i = 0; i < 400; i += 1) entries.push(blob(`src/domain/entity_${i}.ts`, 1000 + i));
    const text = compressListing(analyzeTree(entries), 1500);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(1500);
    expect(text).toContain("## 用語集");
    expect(text).toMatch(/…ほか \d+ 件/);
    expect(text).toContain("## ディレクトリ");
  });

  test("長いパスや小さな予算でも、どの行も含めて予算を超えない", () => {
    const longDir = (i: number) => `${"d".repeat(180)}${i}`;
    const entries: TreeEntry[] = [];
    for (let i = 0; i < 40; i += 1) entries.push(blob(`${longDir(i)}/models/order.ts`, 500 + i));
    entries.push(blob("README.md", 300));
    const analysis = analyzeTree(entries);
    for (const budget of [0, 10, 60, 200, 1000, 4500]) {
      const text = compressListing(analysis, budget);
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(budget);
    }
  });

  test("「ほか N 件」の分も予算に含める", () => {
    const entries: TreeEntry[] = [];
    for (let i = 0; i < 30; i += 1) entries.push(blob(`src/domain/e${i}.ts`, 1000));
    const analysis = analyzeTree(entries);
    for (let budget = 150; budget < 700; budget += 7) {
      const text = compressListing(analysis, budget);
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(budget);
    }
  });

  test("捨てた件数を理由ごとに出す", () => {
    const text = compressListing(analyzeTree([blob("README.md"), blob("a.png"), blob("b.png")]));
    expect(text).toContain("捨てた: binary 2");
  });
});

describe("detectMonorepo", () => {
  test("apps/* と packages/* に README か manifest があればモノレポ。共有は既定で選ぶ", () => {
    const result = detectMonorepo([
      blob("apps/web/package.json"),
      blob("apps/api/README.md"),
      blob("packages/domain/package.json"),
      blob("packages/ui/src/a.ts"),
    ]);
    expect(result).toEqual([
      { path: "apps/api", shared: false },
      { path: "apps/web", shared: false },
      { path: "packages/domain", shared: true },
    ]);
  });

  test("1 つしか無ければモノレポとみなさない", () => {
    expect(detectMonorepo([blob("apps/web/package.json"), blob("src/a.ts")])).toBeNull();
    expect(detectMonorepo([blob("src/a.ts")])).toBeNull();
  });
});

describe("validateTargets", () => {
  const entries = [dir("apps"), dir("apps/web"), blob("apps/web/a.ts"), blob("README.md")];
  const ok = { folders: [], files: [], issues: [] };

  test("存在する指定は通る", () => {
    expect(
      validateTargets(entries, { folders: ["apps/web"], files: ["README.md"], issues: [3] }),
    ).toBeNull();
    expect(validateTargets(entries, ok)).toBeNull();
  });

  test("ツリーに無いパス・ファイルとフォルダの取り違えは弾く", () => {
    expect(validateTargets(entries, { ...ok, folders: ["apps/api"] })).toEqual({
      code: "unknown_path",
      field: "folders",
      path: "apps/api",
    });
    expect(validateTargets(entries, { ...ok, files: ["apps/web"] })).toMatchObject({
      code: "unknown_path",
      field: "files",
    });
    expect(validateTargets(entries, { ...ok, folders: ["README.md"] })).toMatchObject({
      code: "unknown_path",
    });
  });

  test("上限を超える大きさの指定ファイルは断る（黙って外さない）", () => {
    const big = [blob("docs/big.md", MAX_FILE_BYTES + 1), blob("docs/ok.md", MAX_FILE_BYTES)];
    expect(validateTargets(big, { ...ok, files: ["docs/big.md"] })).toEqual({
      code: "too_large",
      field: "files",
      path: "docs/big.md",
      size: MAX_FILE_BYTES + 1,
      max: MAX_FILE_BYTES,
    });
    expect(validateTargets(big, { ...ok, files: ["docs/ok.md"] })).toBeNull();
  });

  test("ファイル・Issue は 5 個まで。Issue 番号は正の整数", () => {
    const six = ["a", "b", "c", "d", "e", "f"];
    expect(validateTargets(entries, { ...ok, files: six })).toEqual({
      code: "too_many",
      field: "files",
      max: 5,
    });
    expect(validateTargets(entries, { ...ok, issues: [1, 2, 3, 4, 5, 6] })).toMatchObject({
      code: "too_many",
      field: "issues",
    });
    expect(validateTargets(entries, { ...ok, issues: [0] })).toEqual({
      code: "invalid_issue",
      number: 0,
    });
    expect(validateTargets(entries, { ...ok, issues: [1.5] })).toMatchObject({
      code: "invalid_issue",
    });
  });
});
