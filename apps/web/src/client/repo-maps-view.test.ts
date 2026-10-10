import { describe, expect, it } from "vitest";
import {
  scopeSummary,
  groupByKind,
  wizardStepOf,
  wizardSteps,
  arrangeCandidates,
  asNodeKind,
  buildConfirmRequest,
  checkHintFiles,
  evidenceCounts,
  filterFileOptions,
  groupByEvidenceKind,
  nodeKindsOf,
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

  it("ブランチ名に / が入る URL は、一覧にあるパスで切れ目を決める", () => {
    const known = new Set(["docs/guide.md"]);
    expect(normalizeHintPath("https://github.com/o/r/blob/release/2026/docs/guide.md", known)).toBe(
      "docs/guide.md",
    );
    // 一覧が無いときは、ブランチを 1 区切りとして外す。
    expect(normalizeHintPath("https://github.com/o/r/blob/main/docs/guide.md")).toBe(
      "docs/guide.md",
    );
    expect(normalizeHintPath("https://github.com/o/r/blob/main/docs/guide.md#L3-L9")).toBe(
      "docs/guide.md",
    );
  });

  it("普通のパスの # はファイル名として残す", () => {
    expect(normalizeHintPath("docs/C#-guide.md")).toBe("docs/C#-guide.md");
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

describe("ノードの種類（#322）", () => {
  it("知らない値は種類なしにする", () => {
    expect(asNodeKind("core")).toBe("core");
    expect(asNodeKind("person")).toBeNull();
    expect(asNodeKind(undefined)).toBeNull();
  });

  it("根拠の応答から、種類を持つノードだけを取り出す", () => {
    const state = {
      kind: "ok" as const,
      sources: {
        repo: { url: "github.com/o/r", commitSha: "abc" },
        nodes: [
          { conceptId: "a", kind: "event" as const, sources: [] },
          { conceptId: "b", kind: null, sources: [] },
          { conceptId: "c", sources: [] },
        ],
      },
    };
    expect([...nodeKindsOf(state)]).toEqual([["a", "event"]]);
    expect(nodeKindsOf({ kind: "none" }).size).toBe(0);
    expect(nodeKindsOf(undefined).size).toBe(0);
  });

  it("確定の入力には、直した種類だけを入れる（null は種類なしに直した）", () => {
    const base = { ...candidate("C1", "a", 1), kind: "core" as const };
    const other = candidate("C2", "b", 1);
    const request = buildConfirmRequest(
      [base, other, candidate("C3", "c", 1)],
      new Set(["C1", "C2", "C3"]),
      { C1: { kind: "core" }, C2: { kind: "state" }, C3: { kind: null } },
      "",
    );
    expect(request.accepted).toEqual([{ id: "C1" }, { id: "C2", kind: "state" }, { id: "C3" }]);
    const cleared = buildConfirmRequest([base], new Set(["C1"]), { C1: { kind: null } }, "");
    expect(cleared.accepted).toEqual([{ id: "C1", kind: null }]);
  });
});

describe("作成の手順と種類の列（#322）", () => {
  it("手順は、いまの段より前を済み・いまを現在・後ろを未にする", () => {
    expect(wizardSteps(3).map((s) => s.state)).toEqual(["done", "done", "current", "todo"]);
    expect(wizardSteps(5).every((s) => s.state === "done")).toBe(true);
  });

  it("下書きの段を手順に直す", () => {
    expect(wizardStepOf({ kind: "summarize", resume: false })).toBe(2);
    expect(wizardStepOf({ kind: "candidates" })).toBe(2);
    expect(wizardStepOf({ kind: "choose" })).toBe(3);
    expect(wizardStepOf({ kind: "confirmed", mapId: "m" })).toBe(5);
  });

  it("種類ごとの列にする。5 列は空でも出し、種類なしは中身があるときだけ末尾に出す", () => {
    const items = [
      { id: "a", kind: "state" as const },
      { id: "b", kind: null },
      { id: "c", kind: "state" as const },
    ];
    const columns = groupByKind(items, (i) => i.kind);
    expect(columns.map((c) => c.kind)).toEqual([
      "core",
      "event",
      "state",
      "record",
      "system",
      null,
    ]);
    expect(columns[2]?.items.map((i) => i.id)).toEqual(["a", "c"]);
    expect(groupByKind([], () => null)).toHaveLength(5);
  });
});

describe("読む範囲（#322 改①）", () => {
  const inspected = {
    monorepo: [
      { path: "apps/api", shared: false },
      { path: "apps/web", shared: false },
      { path: "packages/domain", shared: true },
    ],
    folders: [],
    folderStats: {
      "apps/api": { doc: 1, code: 120, schema: 0 },
      "apps/web": { doc: 0, code: 98, schema: 0 },
      "packages/domain": { doc: 2, code: 33, schema: 1 },
    },
    scan: { blobTotal: 310, kept: { doc: 3, glossary: 1, code: 251, schema: 1 }, dropped: {} },
  };

  it("何も選ばなければ全体を読む（合計は走査の件数）", () => {
    const s = scopeSummary(inspected, new Set(), []);
    expect(s.readsAll).toBe(true);
    expect(s.rows.every((r) => r.reading)).toBe(true);
    expect(s.totals).toEqual({ doc: 4, code: 251, schema: 1 });
  });

  it("選んだフォルダだけを読み、合計はその分。フォルダの外の参考ファイルも数える", () => {
    const s = scopeSummary(inspected, new Set(["apps/api", "packages/domain"]), [
      "apps/api/src/a.ts",
      "docs/idea.md",
    ]);
    expect(s.rows.map((r) => r.reading)).toEqual([true, false, true]);
    expect(s.totals).toEqual({ doc: 3, code: 153, schema: 1 });
    expect(s.rows[0]?.pinned).toBe(1);
    expect(s.outsidePinned).toBe(1);
  });

  it("入れ子のフォルダを両方選んでも二重に数えない。古い API では合計を出さない", () => {
    const nested = {
      monorepo: null,
      folders: ["apps", "apps/api"],
      folderStats: {
        apps: { doc: 1, code: 10, schema: 0 },
        "apps/api": { doc: 1, code: 4, schema: 0 },
      },
      scan: inspected.scan,
    };
    expect(scopeSummary(nested, new Set(["apps", "apps/api"]), []).totals).toEqual({
      doc: 1,
      code: 10,
      schema: 0,
    });
    const old = { ...inspected, folderStats: undefined };
    expect(scopeSummary(old, new Set(["apps/api"]), []).totals).toBeNull();
  });
});
