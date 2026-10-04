import { MAX_OBJECTIVE_IDS_PER_EVENT } from "@gakushu-sochi/domain";
import { describe, expect, test } from "vitest";
import { parseAnswer } from "./answer";
import { META_MARKER } from "./prompt";

function withMeta(meta: unknown): string {
  return `本文\n${META_MARKER}\n${JSON.stringify(meta)}`;
}

const CONCEPTS = new Set(["go.defer", "go.slice"]);
const OBJECTIVES = new Map([
  ["go.defer:lifo_order", "go.defer"],
  ["go.defer:execution_timing", "go.defer"],
  ["go.slice:append_growth", "go.slice"],
]);

describe("parseAnswer の objectiveIds（設計/04 #223）", () => {
  test("一覧に載っている項目 ID だけを受理する", () => {
    const parsed = parseAnswer(
      withMeta({
        conceptIds: ["go.defer"],
        objectiveIds: ["go.defer:lifo_order", "go.defer:unknown", "ts.any:x", 1],
      }),
      CONCEPTS,
      OBJECTIVES,
    );

    expect(parsed.objectiveIds).toEqual(["go.defer:lifo_order"]);
  });

  test("項目の Concept が conceptIds に無ければ補う", () => {
    // conceptIds に無い Concept の項目は習熟度の導出で無視されるため。
    const parsed = parseAnswer(
      withMeta({ conceptIds: ["go.defer"], objectiveIds: ["go.slice:append_growth"] }),
      CONCEPTS,
      OBJECTIVES,
    );

    expect(parsed.conceptIds).toEqual(["go.defer", "go.slice"]);
  });

  test("重複を除き、API の上限件数で切る", () => {
    const many = new Map(
      Array.from({ length: MAX_OBJECTIVE_IDS_PER_EVENT + 5 }, (_, i) => [
        `go.defer:item_${i}`,
        "go.defer",
      ]),
    );
    const parsed = parseAnswer(
      withMeta({
        conceptIds: ["go.defer"],
        objectiveIds: ["go.defer:item_0", "go.defer:item_0", ...many.keys()],
      }),
      CONCEPTS,
      many,
    );

    expect(parsed.objectiveIds).toHaveLength(MAX_OBJECTIVE_IDS_PER_EVENT);
    expect(new Set(parsed.objectiveIds).size).toBe(MAX_OBJECTIVE_IDS_PER_EVENT);
  });

  test("objectiveIds が無い・配列でない・メタ情報が読めないときは空配列", () => {
    expect(parseAnswer(withMeta({ conceptIds: [] }), CONCEPTS, OBJECTIVES).objectiveIds).toEqual(
      [],
    );
    expect(
      parseAnswer(withMeta({ objectiveIds: "go.defer:lifo_order" }), CONCEPTS, OBJECTIVES)
        .objectiveIds,
    ).toEqual([]);
    expect(parseAnswer("本文だけ", CONCEPTS, OBJECTIVES).objectiveIds).toEqual([]);
  });
});
