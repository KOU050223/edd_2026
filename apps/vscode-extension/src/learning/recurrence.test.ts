import { expect, test } from "vitest";
import {
  findRecurred,
  isExplainedErrors,
  markExplained,
  RECURRENCE_WINDOW_MS,
  type ExplainedErrors,
} from "./recurrence";

const FIRST = new Date("2026-09-01T00:00:00.000Z");
const later = (ms: number) => new Date(FIRST.getTime() + ms);

test("一度解説したエラーを時間窓の内に再び解説すると再発になる", () => {
  const explained = markExplained({}, ["code:ts:2345"], ["ts.type_annotation"], FIRST);

  expect(findRecurred(explained, ["code:ts:2345"], ["ts.type_annotation"], later(60_000))).toEqual([
    { key: "code:ts:2345", conceptIds: ["ts.type_annotation"] },
  ]);
});

test("別のエラーは再発にならない", () => {
  const explained = markExplained({}, ["code:ts:2345"], ["ts.type_annotation"], FIRST);

  expect(findRecurred(explained, ["code:ts:2322"], ["ts.type_annotation"], later(60_000))).toEqual(
    [],
  );
});

test("初めて解説するエラーは再発にならない", () => {
  expect(findRecurred({}, ["code:ts:2345"], ["ts.type_annotation"], FIRST)).toEqual([]);
});

test("時間窓を過ぎた解説は再発の根拠にしない", () => {
  // 数ヶ月前に一度出したエラーで直近の理解を下げない。
  const explained = markExplained({}, ["code:ts:2345"], ["ts.type_annotation"], FIRST);

  expect(findRecurred(explained, ["code:ts:2345"], [], later(RECURRENCE_WINDOW_MS))).toHaveLength(
    1,
  );
  expect(findRecurred(explained, ["code:ts:2345"], [], later(RECURRENCE_WINDOW_MS + 1))).toEqual(
    [],
  );
});

test("Conceptは前回と今回の和集合にする", () => {
  // 今回モデルが Concept を返さなくても、前回の Concept へ再発を反映する。
  const explained = markExplained({}, ["code:ts:2345"], ["ts.type_annotation"], FIRST);

  expect(findRecurred(explained, ["code:ts:2345"], [], later(1))[0]?.conceptIds).toEqual([
    "ts.type_annotation",
  ]);
  expect(
    findRecurred(explained, ["code:ts:2345"], ["ts.function"], later(1))[0]?.conceptIds,
  ).toEqual(["ts.type_annotation", "ts.function"]);
});

test("同じキーが1回の選択に重複しても再発は1件にまとめる", () => {
  const explained = markExplained({}, ["code:ts:2345"], ["ts.type_annotation"], FIRST);

  expect(findRecurred(explained, ["code:ts:2345", "code:ts:2345"], [], later(1))).toHaveLength(1);
});

test("解説し直すと時刻を更新し、前回のConceptを残す", () => {
  const first = markExplained({}, ["code:ts:2345"], ["ts.type_annotation"], FIRST);
  const second = markExplained(first, ["code:ts:2345"], [], later(1_000));

  expect(second["code:ts:2345"]).toEqual({
    explainedAt: later(1_000).toISOString(),
    conceptIds: ["ts.type_annotation"],
  });
});

test("時間窓を過ぎた記録は保存値から捨てる", () => {
  const old = markExplained({}, ["code:ts:2345"], ["ts.type_annotation"], FIRST);

  const next = markExplained(old, ["code:ts:2322"], [], later(RECURRENCE_WINDOW_MS + 1));

  expect(Object.keys(next)).toEqual(["code:ts:2322"]);
});

test("保存値の形を検査する", () => {
  const valid: ExplainedErrors = {
    "code:ts:2345": { explainedAt: FIRST.toISOString(), conceptIds: ["ts.type_annotation"] },
  };

  expect(isExplainedErrors(valid)).toBe(true);
  expect(isExplainedErrors({})).toBe(true);
  expect(isExplainedErrors([])).toBe(false);
  expect(isExplainedErrors(null)).toBe(false);
  expect(isExplainedErrors({ k: { explainedAt: "not-a-date", conceptIds: [] } })).toBe(false);
  expect(isExplainedErrors({ k: { explainedAt: FIRST.toISOString() } })).toBe(false);
  expect(isExplainedErrors({ k: { explainedAt: FIRST.toISOString(), conceptIds: [1] } })).toBe(
    false,
  );
});
