import { expect, test } from "vitest";
import { CONCEPT_ID_PATTERN } from "@gakushu-sochi/domain";
import { randomKey, resolveMapContent } from "./content.js";

function keys(...values: string[]) {
  return () => {
    const value = values.shift();
    if (value === undefined) throw new Error("no more keys");
    return value;
  };
}

const own = (ref: string) => ({ kind: "own" as const, ref, label: ref, summary: "s" });

test("randomKey は英小文字と数字 8 文字を返す", () => {
  for (let i = 0; i < 100; i++) expect(randomKey()).toMatch(/^[a-z0-9]{8}$/);
});

test("振ったノードの ID は今の Concept ID の形を満たす", () => {
  const result = resolveMapContent(
    "m7k2x9qa",
    { title: "t", description: "", nodes: [own("new:a")], edges: [] },
    new Set(),
    randomKey,
  );
  if (!result.ok) throw new Error(result.error);
  expect(result.content.nodes[0]!.conceptId).toMatch(CONCEPT_ID_PATTERN);
});

test("識別子が既存のノードと重なったら引き直す", () => {
  const result = resolveMapContent(
    "m1",
    { title: "t", description: "", nodes: [own("m1.aaaaaaaa"), own("new:b")], edges: [] },
    new Set(["m1.aaaaaaaa"]),
    keys("aaaaaaaa", "bbbbbbbb"),
  );
  expect(result).toMatchObject({ ok: true, assigned: { "new:b": "m1.bbbbbbbb" } });
});

test("合流（前提が複数）は循環ではない", () => {
  const result = resolveMapContent(
    "m1",
    {
      title: "t",
      description: "",
      nodes: [own("new:a"), own("new:b"), own("new:c")],
      edges: [
        { from: "new:a", to: "new:c" },
        { from: "new:b", to: "new:c" },
        { from: "new:a", to: "new:b" },
      ],
    },
    new Set(),
    keys("a", "b", "c"),
  );
  expect(result.ok).toBe(true);
});

test.each([
  [
    "自己ループ",
    [own("new:a")],
    [{ from: "new:a", to: "new:a" }],
    "edge must not point to itself: new:a",
  ],
  [
    "3つのノードの循環",
    [own("new:a"), own("new:b"), own("new:c")],
    [
      { from: "new:a", to: "new:b" },
      { from: "new:b", to: "new:c" },
      { from: "new:c", to: "new:a" },
    ],
    "edges must not form a cycle",
  ],
  [
    "重複した線",
    [own("new:a"), own("new:b")],
    [
      { from: "new:a", to: "new:b" },
      { from: "new:a", to: "new:b" },
    ],
    "duplicate edge: new:a -> new:b",
  ],
  ["重複したノード", [own("new:a"), own("new:a")], [], "duplicate node: new:a"],
])("%s は拒否する", (_name, nodes, edges, error) => {
  const result = resolveMapContent(
    "m1",
    { title: "t", description: "", nodes, edges },
    new Set(),
    keys("a", "b", "c"),
  );
  expect(result).toEqual({ ok: false, error });
});
