import { expect, test } from "vitest";
import type { MasteryStatus } from "@gakushu-sochi/domain";
import { compareConceptView, type ConceptMasteryView } from "./learning-profile.js";

function view(conceptId: string, status: MasteryStatus, score: number): ConceptMasteryView {
  return {
    conceptId,
    status,
    score,
    evidence: {
      questionCount: 0,
      answerViewCount: 0,
      solvedIndependentlyCount: 0,
      errorRecurrenceCount: 0,
      checkPassedCount: 0,
      checkFailedCount: 0,
      recentTypes: [],
    },
  };
}

test("confirmed を learning より前に並べる", () => {
  const items = [view("go.a", "learning", 0.6), view("go.b", "confirmed", 0.7)];

  expect(items.sort(compareConceptView).map((c) => c.conceptId)).toEqual(["go.b", "go.a"]);
});

test("status が score より優先される", () => {
  // learning の上限(0.69)は confirmed の下限(0.7)を超えないが、
  // score だけで並べる実装になっていないことを固定しておく。
  const items = [view("go.high", "learning", 0.69), view("go.low", "confirmed", 0.7)];

  expect(items.sort(compareConceptView).map((c) => c.conceptId)).toEqual(["go.low", "go.high"]);
});

test("同じ status なら score の降順に並べる", () => {
  const items = [
    view("go.low", "learning", 0.1),
    view("go.high", "learning", 0.6),
    view("go.mid", "learning", 0.3),
  ];

  expect(items.sort(compareConceptView).map((c) => c.conceptId)).toEqual([
    "go.high",
    "go.mid",
    "go.low",
  ]);
});

test("status と score が同じなら Concept ID の昇順に並べる", () => {
  const items = [view("go.zebra", "learning", 0.3), view("go.alpha", "learning", 0.3)];

  expect(items.sort(compareConceptView).map((c) => c.conceptId)).toEqual(["go.alpha", "go.zebra"]);
});

test("入力順が違っても並び順は同一になる", () => {
  const build = (): ConceptMasteryView[] => [
    view("go.a", "confirmed", 0.9),
    view("go.b", "learning", 0.3),
    view("go.c", "learning", 0.3),
    view("go.d", "confirmed", 0.9),
  ];

  // 全順序でないと、同じデータでもレスポンスの並びが揺れて
  // クライアントの差分描画とキャッシュ比較が無駄に走る。
  const sorted = build()
    .sort(compareConceptView)
    .map((c) => c.conceptId);
  const fromReversed = build()
    .reverse()
    .sort(compareConceptView)
    .map((c) => c.conceptId);

  expect(fromReversed).toEqual(sorted);
  expect(sorted).toEqual(["go.a", "go.d", "go.b", "go.c"]);
});
