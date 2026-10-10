import { describe, expect, it } from "vitest";

import type { LearningEvidence } from "@gakushu-sochi/domain";

import { MAX_EVIDENCE_PER_IMPORT, parseExcludedConceptIds, prepareApplyEvidence } from "./apply.js";

function evidence(id: string, conceptIds: string[]): LearningEvidence {
  return {
    id,
    conceptIds,
    source: { provider: "codex", importedBy: "desktop" },
    kind: "debugging",
    confidence: 0.5,
  };
}

describe("parseExcludedConceptIds", () => {
  it("keeps only string concept ids", () => {
    expect(
      parseExcludedConceptIds({
        excludeConceptIds: ["ts.type_narrowing", 42, null, "go.error_handling"],
      }),
    ).toEqual(new Set(["ts.type_narrowing", "go.error_handling"]));
  });

  it("returns an empty set when payload or excludeConceptIds is absent", () => {
    expect(parseExcludedConceptIds(undefined)).toEqual(new Set());
    expect(parseExcludedConceptIds({})).toEqual(new Set());
    expect(parseExcludedConceptIds({ excludeConceptIds: "ts.type_narrowing" })).toEqual(new Set());
  });
});

describe("prepareApplyEvidence", () => {
  it("removes excluded concepts from each evidence item", () => {
    const items = [
      evidence("e1", ["ts.type_narrowing", "go.error_handling"]),
      evidence("e2", ["go.pointer_receiver"]),
    ];
    const result = prepareApplyEvidence(items, new Set(["go.error_handling"]));
    expect(result.map((item) => item.conceptIds)).toEqual([
      ["ts.type_narrowing"],
      ["go.pointer_receiver"],
    ]);
  });

  it("drops evidence items whose concepts are all excluded", () => {
    const items = [evidence("e1", ["ts.type_narrowing"]), evidence("e2", ["go.pointer_receiver"])];
    const result = prepareApplyEvidence(
      items,
      new Set(["ts.type_narrowing", "go.pointer_receiver"]),
    );
    expect(result).toEqual([]);
  });

  it("throws with the count when evidence exceeds the API limit", () => {
    const items = Array.from({ length: MAX_EVIDENCE_PER_IMPORT + 1 }, (_, i) =>
      evidence(`e${i}`, ["ts.type_narrowing"]),
    );
    expect(() => prepareApplyEvidence(items, new Set())).toThrow(
      `上限を超えています（${(MAX_EVIDENCE_PER_IMPORT + 1).toLocaleString()} 件）`,
    );
  });

  it("accepts exactly the limit", () => {
    const items = Array.from({ length: MAX_EVIDENCE_PER_IMPORT }, (_, i) =>
      evidence(`e${i}`, ["ts.type_narrowing"]),
    );
    expect(prepareApplyEvidence(items, new Set())).toHaveLength(MAX_EVIDENCE_PER_IMPORT);
  });
});
