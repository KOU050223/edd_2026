import { expect, test, vi } from "vitest";
import { parsePeriodSearch, resolvePeriod } from "./activity-period.js";
import { ACTIVITY_PERIOD_DAYS } from "../shared/settings.js";

test.each(ACTIVITY_PERIOD_DAYS)("選択肢にある %i 日はそのまま採用する", (days) => {
  expect(parsePeriodSearch({ days })).toEqual({ days });
});

test("文字列で来ても数値として読む（URL の検索パラメータは文字列で届く）", () => {
  expect(parsePeriodSearch({ days: "7" })).toEqual({ days: 7 });
});

test.each([
  ["選択肢に無い数値", { days: 31 }],
  ["負の数", { days: -7 }],
  ["数値でない文字列", { days: "abc" }],
  ["空文字", { days: "" }],
  ["null", { days: null }],
  ["指定なし", {}],
  // `Number([])` は 0、`Number(["7"])` は 7 になる。後者を通すと
  // 配列で来た指定が黙って採用される。型ガードが弾くことを固定する。
  ["空配列", { days: [] }],
])("%s は指定なしとして扱う", (_label, search) => {
  expect(parsePeriodSearch(search)).toEqual({});
});

test("配列で複数指定されても採用しない", () => {
  // 同じ名前が2回現れた検索パラメータ。どちらを選ぶかを勝手に決めない。
  expect(parsePeriodSearch({ days: ["7", "30"] })).toEqual({});
});

test("URL に指定があれば設定を読まない", async () => {
  const loadDefault = vi.fn(async () => 90 as const);

  expect(await resolvePeriod(7, loadDefault)).toBe(7);
  expect(loadDefault).not.toHaveBeenCalled();
});

test("URL に指定が無ければ設定の既定値を使う", async () => {
  const loadDefault = vi.fn(async () => 90 as const);

  expect(await resolvePeriod(undefined, loadDefault)).toBe(90);
  expect(loadDefault).toHaveBeenCalledTimes(1);
});

test("設定の読み込みが失敗したら、その失敗をそのまま投げる", async () => {
  // 既定値へ黙って倒すと、利用者が保存した期間を無視した表示を
  // 成功したように見せてしまう（RULE-004）。
  const failure = new Error("unavailable");

  await expect(resolvePeriod(undefined, () => Promise.reject(failure))).rejects.toThrow(failure);
});

test("検証済みの型に見える値でも、選択肢外なら捨てる", () => {
  // `validateSearch` が捨てた値は `search` から消えない（TanStack/router#1965）。
  // 型の上では `days?: 7|30|90` に見えるが、実際には URL の生の値が入る。
  // `loaderDeps` はこの関数をもう一度通すことで、検証していない値が
  // API の要求に載るのを防いでいる。
  const leaked = { days: 999 } as unknown as Record<string, unknown>;

  expect(parsePeriodSearch(leaked)).toEqual({});
});
