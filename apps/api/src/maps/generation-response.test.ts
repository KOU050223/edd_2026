import { describe, expect, it } from "vitest";
import { MAX_GENERATED_NODES } from "../contract/learning-maps.js";
import { parseObjectives, parseSkeleton } from "./generation-response.js";

const CANDIDATES = new Set(["go.defer"]);

function skeleton(nodes: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ title: "Go で Web API", description: "説明", nodes, ...extra });
}

describe("parseSkeleton", () => {
  it("新しいノードと参照のノードを、学ぶ順と前提つきで読む", () => {
    const result = parseSkeleton(
      skeleton([
        {
          key: "n1",
          label: "HTTP の基本",
          summary: "リクエストとレスポンス。",
          prerequisite: null,
        },
        { key: "n2", conceptId: "go.defer", prerequisite: "n1" },
        { key: "n3", label: "ハンドラ", summary: "net/http で書く。", prerequisite: "n2" },
      ]),
      CANDIDATES,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        title: "Go で Web API",
        description: "説明",
        nodes: [
          { kind: "own", key: "n1", label: "HTTP の基本", summary: "リクエストとレスポンス。" },
          { kind: "reference", key: "n2", conceptId: "go.defer", prerequisite: "n1" },
          {
            kind: "own",
            key: "n3",
            label: "ハンドラ",
            summary: "net/http で書く。",
            prerequisite: "n2",
          },
        ],
      },
    });
  });

  it("ノードが上限を超えたら、切り詰めずに拒否する", () => {
    const nodes = Array.from({ length: MAX_GENERATED_NODES + 1 }, (_, index) => ({
      key: `n${String(index + 1)}`,
      label: "表示名",
      summary: "概要",
    }));

    expect(parseSkeleton(skeleton(nodes), CANDIDATES)).toMatchObject({
      ok: false,
      reason: "shape",
    });
  });

  it("前提が自分より後ろのノードを指していたら、木にならないので拒否する", () => {
    const result = parseSkeleton(
      skeleton([
        { key: "n1", label: "a", summary: "a", prerequisite: "n2" },
        { key: "n2", label: "b", summary: "b", prerequisite: "n1" },
      ]),
      CANDIDATES,
    );

    expect(result).toMatchObject({ ok: false, reason: "structure" });
  });

  it("key が重なっていたら拒否する", () => {
    const result = parseSkeleton(
      skeleton([
        { key: "n1", label: "a", summary: "a" },
        { key: "n1", label: "b", summary: "b" },
      ]),
      CANDIDATES,
    );

    expect(result).toMatchObject({ ok: false, reason: "structure" });
  });

  it("候補に無い Concept の参照は拒否する", () => {
    const result = parseSkeleton(skeleton([{ key: "n1", conceptId: "go.goroutine" }]), CANDIDATES);

    expect(result).toMatchObject({ ok: false, reason: "unknown-reference" });
  });

  it("同じ Concept を2回参照したら拒否する", () => {
    const result = parseSkeleton(
      skeleton([
        { key: "n1", conceptId: "go.defer" },
        { key: "n2", conceptId: "go.defer" },
      ]),
      CANDIDATES,
    );

    expect(result).toMatchObject({ ok: false, reason: "structure" });
  });

  it("概要の無い新しいノードや、表示名を持つ参照のノードは拒否する", () => {
    expect(parseSkeleton(skeleton([{ key: "n1", label: "a" }]), CANDIDATES)).toMatchObject({
      ok: false,
      reason: "shape",
    });
    expect(
      parseSkeleton(skeleton([{ key: "n1", conceptId: "go.defer", label: "defer" }]), CANDIDATES),
    ).toMatchObject({ ok: false, reason: "shape" });
  });

  it("JSON でない本文は拒否する", () => {
    expect(parseSkeleton("```json\n{}\n```", CANDIDATES)).toMatchObject({
      ok: false,
      reason: "not-json",
    });
  });
});

describe("parseObjectives", () => {
  it("頼んだノードのちょうど全部に項目があれば読む", () => {
    const result = parseObjectives(
      JSON.stringify({
        nodes: [
          { key: "n1", objectives: ["a", "b"] },
          { key: "n3", objectives: ["c", "d", "e"] },
        ],
      }),
      ["n1", "n3"],
    );

    expect(result).toEqual({
      ok: true,
      value: new Map([
        ["n1", ["a", "b"]],
        ["n3", ["c", "d", "e"]],
      ]),
    });
  });

  it("足りないノード・頼んでいないノード・範囲外の数・重複は拒否する", () => {
    const cases = [
      { nodes: [{ key: "n1", objectives: ["a", "b"] }] },
      {
        nodes: [
          { key: "n1", objectives: ["a", "b"] },
          { key: "n2", objectives: ["a", "b"] },
          { key: "n9", objectives: ["a", "b"] },
        ],
      },
      {
        nodes: [
          { key: "n1", objectives: ["a"] },
          { key: "n2", objectives: ["a", "b"] },
        ],
      },
      {
        nodes: [
          { key: "n1", objectives: ["a", "b", "c", "d", "e", "f"] },
          { key: "n2", objectives: ["a", "b"] },
        ],
      },
      {
        nodes: [
          { key: "n1", objectives: ["a", "a"] },
          { key: "n2", objectives: ["a", "b"] },
        ],
      },
    ];
    for (const body of cases) {
      expect(parseObjectives(JSON.stringify(body), ["n1", "n2"])).toMatchObject({
        ok: false,
        reason: "objectives",
      });
    }
  });
});
