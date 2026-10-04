import { expect, test } from "vitest";
import {
  previousAnswerObjectiveIds,
  shouldRecordSolvedIndependently,
  solvedIndependentlyTarget,
} from "./resolution";

test("初回応答がresolvedを返しても自力解決イベントを記録しない", () => {
  expect(
    shouldRecordSolvedIndependently([], {
      resolution: "resolved",
      conceptIds: ["go.error_handling"],
    }),
  ).toBe(false);
});

test("会話履歴がありresolvedかつConceptがあれば自力解決イベントを記録する", () => {
  expect(
    shouldRecordSolvedIndependently(
      [{ role: "assistant", text: "エラー処理を確認してください。" }],
      { resolution: "resolved", conceptIds: ["go.error_handling"] },
    ),
  ).toBe(true);
});

// --- 自力解決で上げる項目は前の回答が触れたもの（#223 / PR #232 のレビュー） ---------

const requestTurn = { prompt: "defer の順番が分かりません" };

function responseTurn(metadata: unknown) {
  return { response: [], result: { metadata } };
}

test("最後の応答の metadata から、前の回答が触れた項目を読む", () => {
  expect(
    previousAnswerObjectiveIds([
      requestTurn,
      responseTurn({ objectiveIds: ["go.slice:append_growth"] }),
      requestTurn,
      responseTurn({ objectiveIds: ["go.defer:lifo_order", "go.defer:lifo_order"] }),
      requestTurn,
    ]),
  ).toEqual(["go.defer:lifo_order"]);
});

test("最後の応答に項目が無ければ、それより前の応答へさかのぼらない", () => {
  // 前の回答が項目に触れていないのに、さらに前の項目を自力解決で上げない。
  expect(
    previousAnswerObjectiveIds([
      responseTurn({ objectiveIds: ["go.defer:lifo_order"] }),
      responseTurn(undefined),
    ]),
  ).toEqual([]);
});

test("形の違う metadata の値は受け取らない", () => {
  expect(
    previousAnswerObjectiveIds([
      responseTurn({ objectiveIds: ["go.defer:lifo_order", 1, "not an id", "go.defer"] }),
    ]),
  ).toEqual(["go.defer:lifo_order"]);
  expect(previousAnswerObjectiveIds([responseTurn({ objectiveIds: "go.defer:x" })])).toEqual([]);
  expect(previousAnswerObjectiveIds([])).toEqual([]);
});

test("自力解決の対象は、前の回答の項目と、その項目の Concept を足した conceptIds", () => {
  expect(solvedIndependentlyTarget(["go.goroutine"], ["go.defer:lifo_order"])).toEqual({
    conceptIds: ["go.goroutine", "go.defer"],
    objectiveIds: ["go.defer:lifo_order"],
  });
  expect(solvedIndependentlyTarget(["go.defer"], [])).toEqual({
    conceptIds: ["go.defer"],
    objectiveIds: [],
  });
});
