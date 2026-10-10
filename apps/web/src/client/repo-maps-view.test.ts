import { describe, expect, it } from "vitest";
import {
  arrangeCandidates,
  checkHintFiles,
  evidenceCounts,
  filterFileOptions,
  groupByEvidenceKind,
  normalizeHintPath,
  parseHintFiles,
  splitPath,
  type RepoMapCandidate,
} from "./repo-maps.js";

const candidate = (
  id: string,
  name: string,
  evidence: number,
  description = "",
): RepoMapCandidate => ({
  id,
  name,
  original: "",
  description,
  evidence: Array.from({ length: evidence }, (_, i) => ({
    id: `E${String(i)}`,
    kind: "doc" as const,
    ref: "a.md",
    url: "https://example.com",
  })),
  fromSchema: false,
  schemaOnly: false,
});

describe("normalizeHintPath", () => {
  it("先頭の / と ./、GitHub の blob の URL、行の指定を取る", () => {
    expect(normalizeHintPath("/docs/a.md")).toBe("docs/a.md");
    expect(normalizeHintPath("./docs/a.md")).toBe("docs/a.md");
    expect(normalizeHintPath("https://github.com/o/r/blob/main/docs/a.md#L10")).toBe("docs/a.md");
    expect(normalizeHintPath("  docs/a.md  ")).toBe("docs/a.md");
  });

  it("parseHintFiles は揃えたうえで重複と空行を除く", () => {
    expect(parseHintFiles("/docs/a.md\n\n./docs/a.md\nREADME.md")).toEqual([
      "docs/a.md",
      "README.md",
    ]);
  });
});

describe("checkHintFiles", () => {
  const known = ["docs/concepts.md", "apps/api/src/contract/learning-maps.ts"];

  it("一覧にあるものは found、無いものは missing（近い名前を添える）", () => {
    expect(
      checkHintFiles(["docs/concepts.md", "docs/Concepts.MD", "concepts.md", "x.md"], known, false),
    ).toEqual([
      { path: "docs/concepts.md", state: "found" },
      { path: "docs/Concepts.MD", state: "missing", suggestion: "docs/concepts.md" },
      { path: "concepts.md", state: "missing", suggestion: "docs/concepts.md" },
      { path: "x.md", state: "missing" },
    ]);
  });

  it("一覧が切れているときは、無くても missing と言い切らない", () => {
    expect(checkHintFiles(["x.md"], known, true)).toEqual([{ path: "x.md", state: "unknown" }]);
  });
});

describe("filterFileOptions", () => {
  const options = [
    { path: "docs/a.md", kind: "doc" as const },
    { path: "src/b.ts", kind: "code" as const },
  ];
  it("部分一致で絞り、件数を切る", () => {
    expect(filterFileOptions(options, "DOCS")).toEqual([options[0]]);
    expect(filterFileOptions(options, "", 1)).toEqual([options[0]]);
  });
});

describe("evidenceCounts / groupByEvidenceKind", () => {
  const items = [
    { kind: "code" as const },
    { kind: "doc" as const },
    { kind: "code" as const },
    { kind: "issue" as const },
  ];
  it("種類ごとの件数を決まった順で出す", () => {
    expect(evidenceCounts(items)).toBe("文書 1・コード 2・Issue 1");
    expect(evidenceCounts([])).toBe("");
  });
  it("グループにする（空のグループは作らない）", () => {
    expect(groupByEvidenceKind(items).map((g) => [g.kind, g.items.length])).toEqual([
      ["doc", 1],
      ["code", 2],
      ["issue", 1],
    ]);
  });
});

describe("splitPath", () => {
  it("フォルダとファイル名に分ける", () => {
    expect(splitPath("a/b/c.ts")).toEqual({ dir: "a/b", base: "c.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", base: "README.md" });
  });
});

describe("arrangeCandidates", () => {
  const list = [
    candidate("C1", "学習概念", 1),
    candidate("C2", "マップ", 3, "木の形"),
    candidate("C3", "証跡", 3),
  ];
  it("既定は元の順、根拠順は多い順（同数は元の順）", () => {
    expect(
      arrangeCandidates(list, { query: "", sort: "default", names: {} }).map((c) => c.id),
    ).toEqual(["C1", "C2", "C3"]);
    expect(
      arrangeCandidates(list, { query: "", sort: "evidence", names: {} }).map((c) => c.id),
    ).toEqual(["C2", "C3", "C1"]);
  });
  it("検索語は表示名・説明・直した名前に効く", () => {
    expect(
      arrangeCandidates(list, { query: "木", sort: "default", names: {} }).map((c) => c.id),
    ).toEqual(["C2"]);
    expect(
      arrangeCandidates(list, {
        query: "直した",
        sort: "default",
        names: { C3: "直した名前" },
      }).map((c) => c.id),
    ).toEqual(["C3"]);
  });
});
