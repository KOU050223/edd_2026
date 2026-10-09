import { describe, expect, test } from "vitest";
import type { SharedMapContentView } from "../contract/learning-maps.js";
import { personalCheck } from "./test-map.js";
import { diffContents, isEmptyDiff, parseSnapshot, summarizeDiff } from "./snapshot.js";

const BASE: SharedMapContentView = {
  title: "T",
  description: "D",
  nodes: [
    { kind: "own", conceptId: "m1.a", label: "A", summary: "a", objectives: [] },
    {
      kind: "own",
      conceptId: "m1.b",
      label: "B",
      summary: "b",
      objectives: [{ id: "m1.b:x", label: "x", source: "ai" }],
    },
    { kind: "own", conceptId: "m1.c", label: "C", summary: "c", objectives: [] },
  ],
  edges: [{ from: "m1.a", to: "m1.b" }],
  checks: [personalCheck("m1.b", "m1.b:x")],
};

describe("diffContents", () => {
  test("同じ中身なら空", () => {
    const diff = diffContents(BASE, structuredClone(BASE));
    expect(isEmptyDiff(diff)).toBe(true);
  });

  test("足した・消した・変えたノードと、変わったところを出す", () => {
    const after: SharedMapContentView = {
      ...structuredClone(BASE),
      title: "T2",
      nodes: [
        { kind: "own", conceptId: "m1.a", label: "A", summary: "a2", objectives: [] },
        {
          kind: "own",
          conceptId: "m1.b",
          label: "B",
          summary: "b",
          // 出どころ（source）だけの違いは差分にしない。表示名が変われば出す。
          objectives: [{ id: "m1.b:x", label: "x 改", source: "manual" }],
        },
        { kind: "reference", conceptId: "go.defer", origin: null },
      ],
      edges: [{ from: "go.defer", to: "m1.b" }],
    };
    const diff = diffContents(BASE, after);
    expect(diff.title).toEqual({ before: "T", after: "T2" });
    expect(diff.description).toBeNull();
    expect(diff.added.map((node) => node.conceptId)).toEqual(["go.defer"]);
    expect(diff.removed.map((node) => node.conceptId)).toEqual(["m1.c"]);
    expect(diff.changed.map((change) => [change.conceptId, change.fields])).toEqual([
      ["m1.a", ["summary"]],
      ["m1.b", ["prerequisite", "objectives"]],
    ]);
    expect(diff.changed[1]).toMatchObject({
      prerequisiteBefore: "m1.a",
      prerequisiteAfter: "go.defer",
    });
    expect(summarizeDiff(diff)).toEqual({
      added: 1,
      removed: 1,
      changed: 2,
      titleChanged: true,
      reordered: false,
      checksAdded: 0,
      checksRemoved: 0,
    });
  });

  test("並びだけを変えても差分になる", () => {
    const reversed = {
      ...structuredClone(BASE),
      nodes: [...structuredClone(BASE).nodes].reverse(),
    };
    const diff = diffContents(BASE, reversed);
    expect(diff.reordered).toBe(true);
    expect(diff.changed).toEqual([]);
    expect(isEmptyDiff(diff)).toBe(false);
    // 足した・消したノードで位置がずれただけなら、並びの変更にしない。
    const shifted = { ...structuredClone(BASE), nodes: structuredClone(BASE).nodes.slice(1) };
    expect(diffContents(BASE, shifted).reordered).toBe(false);
  });

  test("確認問題はキーの順に依らずに比べる", () => {
    const original = personalCheck("m1.b", "m1.b:x");
    const { objectiveId, ...rest } = original;
    // D1 から読んだ組は level の後に objectiveId が来る。
    const reorderedKeys = { ...rest, objectiveId } as typeof original;
    const diff = diffContents(BASE, { ...structuredClone(BASE), checks: [reorderedKeys] });
    expect(diff.checks).toEqual({ added: [], removed: [] });
  });

  test("確認問題は中身が変わったら、消して足したものとして数える", () => {
    const changed = { ...personalCheck("m1.b", "m1.b:x"), generatedAt: "2026-10-01T00:00:00.000Z" };
    const diff = diffContents(BASE, { ...structuredClone(BASE), checks: [changed] });
    expect(diff.checks.added).toEqual([changed]);
    expect(diff.checks.removed).toHaveLength(1);
  });

  test("前が無ければ、すべて足したもの", () => {
    const diff = diffContents(null, BASE);
    expect(diff.added).toHaveLength(3);
    expect(diff.title).toEqual({ before: "", after: "T" });
    expect(diff.checks.added).toHaveLength(1);
  });
});

describe("parseSnapshot", () => {
  test("形の違う中身は黙って読まず、例外にする", () => {
    expect(() => parseSnapshot("{", "m1@1")).toThrow(/not JSON: m1@1/);
    expect(() => parseSnapshot(JSON.stringify({ title: "T" }), "m1@2")).toThrow(
      /unexpected shape: m1@2/,
    );
  });
});
