import type { Concept as ConceptDefinition } from "@gakushu-sochi/domain";
import { CONCEPTS } from "@gakushu-sochi/domain";
import { expect, test } from "vitest";
import {
  attachFamiliarity,
  completeConcepts,
  conceptAreas,
  describeFamiliarity,
  findCurrentPosition,
  historySourceLabel,
  layoutTrees,
  linkConcepts,
  summarizeTree,
} from "./learning-map.js";
import { applyOverrides } from "./overrides.js";
import type { Concept, Familiarity } from "./profile.js";

const definition = (id: string, prerequisites: string[] = []): ConceptDefinition => ({
  id,
  label: id,
  language: id.split(".")[0] ?? "",
  prerequisites,
  source: { kind: "manual" },
});

const DEFINITIONS = [
  definition("go.a"),
  definition("go.b", ["go.a"]),
  definition("go.c", ["go.a"]),
  definition("go.d", ["go.b"]),
  definition("ts.a"),
];

const observed = (
  conceptId: string,
  status: Concept["status"],
  lastObservedAt?: string,
): Concept => ({
  conceptId,
  status,
  score: status === "confirmed" ? 0.8 : 0.3,
  evidence: { solvedIndependentlyCount: 1, hintUsedCount: 2, lastObservedAt },
});

test("応答に無い Concept を未観測として補い、定義順に並べる", () => {
  const concepts = completeConcepts([observed("go.c", "learning")], DEFINITIONS);

  expect(concepts.map((concept) => [concept.conceptId, concept.status])).toEqual([
    ["go.a", "unobserved"],
    ["go.b", "unobserved"],
    ["go.c", "learning"],
    ["go.d", "unobserved"],
    ["ts.a", "unobserved"],
  ]);
  expect(concepts[0]?.evidence).toEqual({ solvedIndependentlyCount: 0, hintUsedCount: 0 });
});

test("イベントが 0 件でも全 Concept を未観測として出し、割合は表示しない", () => {
  const concepts = applyOverrides(completeConcepts([], CONCEPTS), {});

  expect(concepts).toHaveLength(CONCEPTS.length);
  expect(concepts.every((concept) => concept.status === "unobserved")).toBe(true);
  expect(concepts.every((concept) => concept.score === null)).toBe(true);
});

test("定義に無い Concept の観測は捨てずに末尾へ残す", () => {
  const concepts = completeConcepts([observed("go.removed", "learning")], DEFINITIONS);

  expect(concepts.at(-1)?.conceptId).toBe("go.removed");
  expect(concepts).toHaveLength(DEFINITIONS.length + 1);
});

test("未観測の Concept にも手動修正を重ね、自動算出より優先する", () => {
  const concepts = applyOverrides(completeConcepts([], DEFINITIONS), {
    "go.d": { status: "confirmed", updatedAt: "2026-09-21T00:00:00.000Z" },
  });
  const d = concepts.find((concept) => concept.conceptId === "go.d");

  expect(d?.status).toBe("confirmed");
  expect(d?.manual).toBe(true);
  expect(d?.derived.status).toBe("unobserved");
});

test("現在地は最後に観測した学習中の Concept", () => {
  const concepts = applyOverrides(
    completeConcepts(
      [
        observed("go.a", "confirmed", "2026-09-23T00:00:00.000Z"),
        observed("go.b", "learning", "2026-09-20T00:00:00.000Z"),
        observed("go.c", "learning", "2026-09-22T00:00:00.000Z"),
      ],
      DEFINITIONS,
    ),
    {},
  );

  expect(findCurrentPosition(concepts)).toBe("go.c");
});

test("手動で学習中から外した Concept は現在地にしない", () => {
  const concepts = applyOverrides(
    completeConcepts(
      [
        observed("go.b", "learning", "2026-09-20T00:00:00.000Z"),
        observed("go.c", "learning", "2026-09-22T00:00:00.000Z"),
      ],
      DEFINITIONS,
    ),
    { "go.c": { status: "confirmed", updatedAt: "2026-09-23T00:00:00.000Z" } },
  );

  expect(findCurrentPosition(concepts)).toBe("go.b");
});

test("観測時刻の無い学習中は、観測のある学習中より後ろに回す", () => {
  const concepts = applyOverrides(
    completeConcepts([observed("go.c", "learning", "2026-09-22T00:00:00.000Z")], DEFINITIONS),
    { "go.a": { status: "learning", updatedAt: "2026-09-23T00:00:00.000Z" } },
  );

  expect(findCurrentPosition(concepts)).toBe("go.c");
});

test("読めない観測時刻の学習中が先に並んでいても、現在地に居座らせない", () => {
  const concepts = applyOverrides(
    completeConcepts(
      [
        observed("go.b", "learning", "not-a-date"),
        observed("go.c", "learning", "2026-09-22T00:00:00.000Z"),
      ],
      DEFINITIONS,
    ),
    {},
  );

  expect(findCurrentPosition(concepts)).toBe("go.c");
});

test("学習中が無ければ現在地は無い", () => {
  const concepts = applyOverrides(completeConcepts([], DEFINITIONS), {});

  expect(findCurrentPosition(concepts)).toBeUndefined();
});

test("現在地を前提に持つ Concept を次に学ぶ候補として引ける", () => {
  const links = linkConcepts(DEFINITIONS);

  expect(links.get("go.a")).toEqual({ prerequisites: [], next: ["go.b", "go.c"] });
  expect(links.get("go.b")).toEqual({ prerequisites: ["go.a"], next: ["go.d"] });
  expect(links.get("go.d")?.next).toEqual([]);
});

test("言語ごとに木を分け、前提の段数で列を決める", () => {
  const trees = layoutTrees(DEFINITIONS);

  expect(trees.map((tree) => tree.language)).toEqual(["go", "ts"]);
  const go = trees[0];
  expect(go?.nodes.map((node) => [node.conceptId, node.depth])).toEqual([
    ["go.a", 0],
    ["go.b", 1],
    ["go.c", 1],
    ["go.d", 2],
  ]);
  expect(go?.edges).toEqual([
    { from: "go.a", to: "go.b" },
    { from: "go.a", to: "go.c" },
    { from: "go.b", to: "go.d" },
  ]);
  expect(go?.depths).toBe(3);
});

test("同じ列の Concept が重ならず、親は子の間に置かれる", () => {
  for (const tree of layoutTrees(CONCEPTS)) {
    const cells = tree.nodes.map((node) => `${node.depth}:${node.row}`);
    expect(new Set(cells).size).toBe(cells.length);
    for (const node of tree.nodes) {
      expect(node.row).toBeGreaterThanOrEqual(0);
      expect(node.row).toBeLessThanOrEqual(tree.rows - 1);
    }
  }
  const go = layoutTrees(DEFINITIONS)[0];
  const row = (id: string) => go?.nodes.find((node) => node.conceptId === id)?.row;
  expect(row("go.a")).toBe(((row("go.b") ?? 0) + (row("go.c") ?? 0)) / 2);
});

test("複数の前提を持つ Concept は最も深い前提の後ろの列に置く", () => {
  const trees = layoutTrees([...DEFINITIONS, definition("go.e", ["go.c", "go.d"])]);
  const e = trees[0]?.nodes.find((node) => node.conceptId === "go.e");

  expect(e?.depth).toBe(3);
  expect(trees[0]?.edges.filter((edge) => edge.to === "go.e")).toHaveLength(2);
});

test("前提が循環していたら黙って欠けた地図を出さずに例外を投げる", () => {
  expect(() => layoutTrees([definition("go.x", ["go.y"]), definition("go.y", ["go.x"])])).toThrow(
    /循環/,
  );
});

test("全 Concept が地図に載る", () => {
  const placed = layoutTrees(CONCEPTS).flatMap((tree) => tree.nodes.map((node) => node.conceptId));

  expect(placed.sort()).toEqual(CONCEPTS.map((concept) => concept.id).sort());
});

test("Concept ID から属する領域を引ける。地図に無い Concept は含まれない", () => {
  const areas = conceptAreas(layoutTrees(DEFINITIONS));

  expect(areas.get("go.a")).toBe("go");
  expect(areas.get("ts.a")).toBe("ts");
  expect(areas.has("go.removed")).toBe(false);
});

const familiarity = (conceptId: string): Familiarity => ({
  conceptId,
  observationCount: 7,
  lastObservedAt: "2026-09-20T00:00:00.000Z",
  maxConfidence: 0.9,
  sources: [{ provider: "codex", count: 7, lastObservedAt: "2026-09-20T00:00:00.000Z" }],
});

test("Familiarity は Concept に結ぶだけで Mastery の値を変えない", () => {
  const concepts = attachFamiliarity(
    applyOverrides(completeConcepts([observed("go.a", "confirmed")], DEFINITIONS), {}),
    [familiarity("go.b")],
  );
  const b = concepts.find((concept) => concept.conceptId === "go.b");

  expect(b?.familiarity?.observationCount).toBe(7);
  expect(b?.status).toBe("unobserved");
  expect(b?.score).toBeNull();
});

test("形跡の無い Concept へは familiarity を付けない", () => {
  const concepts = attachFamiliarity(completeConcepts([], DEFINITIONS), [familiarity("go.a")]);

  expect(concepts.find((concept) => concept.conceptId === "go.a")?.familiarity).toBeDefined();
  expect(concepts.find((concept) => concept.conceptId === "go.b")?.familiarity).toBeUndefined();
});

test("既知のソースは表示名へ、未知のソースは ID をそのまま返す", () => {
  expect(historySourceLabel("codex")).toBe("Codex");
  expect(historySourceLabel("claude-code")).toBe("Claude Code");
  expect(historySourceLabel("unknown-source" as "codex")).toBe("unknown-source");
});

test("「なぜ」の説明はソースの内訳と最後に触れた日付を含む", () => {
  expect(describeFamiliarity(familiarity("go.a"))).toBe("Codex 7件、最後に触れたのは 2026-09-20");
});

test("最後に触れた時刻が無ければ日付の説明を省略する", () => {
  const without = familiarity("go.a");
  delete without.lastObservedAt;

  expect(describeFamiliarity(without)).toBe("Codex 7件");
});

test("領域の集計は木に載っている Concept だけを数える", () => {
  const trees = layoutTrees(DEFINITIONS);
  const concepts = new Map(
    applyOverrides(
      completeConcepts(
        [
          observed("go.a", "confirmed"),
          observed("go.b", "learning"),
          observed("ts.a", "confirmed"),
        ],
        DEFINITIONS,
      ),
      {},
    ).map((concept) => [concept.conceptId, concept]),
  );

  expect(summarizeTree(trees[0]!, concepts)).toEqual({
    confirmed: 1,
    learning: 1,
    unobserved: 2,
    total: 4,
    complete: false,
  });
  // ts は Concept が 1 件で、それが確認済み。全件なのでコンプリートになる。
  expect(summarizeTree(trees[1]!, concepts)).toEqual({
    confirmed: 1,
    learning: 0,
    unobserved: 0,
    total: 1,
    complete: true,
  });
});

test("1 件でも確認済みでない Concept が残っていればコンプリートにしない", () => {
  const trees = layoutTrees(DEFINITIONS);
  const concepts = new Map(
    applyOverrides(
      completeConcepts(
        [
          observed("go.a", "confirmed"),
          observed("go.b", "confirmed"),
          observed("go.c", "confirmed"),
          observed("go.d", "learning"),
        ],
        DEFINITIONS,
      ),
      {},
    ).map((concept) => [concept.conceptId, concept]),
  );

  expect(summarizeTree(trees[0]!, concepts)).toMatchObject({ confirmed: 3, complete: false });
});
