import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  ACTIVITY_PERIOD_DAYS,
  DISPLAY_NAME_MAX_LENGTH,
  isActivityPeriodDays,
  toSettingsInput,
} from "./settings.js";

test("画面の入力から送信する値を作り、表示名を正規化する", () => {
  expect(toSettingsInput({ displayName: "  こう  ", activityPeriodDays: 7 })).toEqual({
    ok: true,
    value: { displayName: "こう", activityPeriodDays: 7 },
  });
});

test("空の表示名は未設定として送る", () => {
  // 空文字を保存すると「未設定」と区別がつかなくなる。null へ寄せる。
  expect(toSettingsInput({ displayName: "   ", activityPeriodDays: 30 })).toEqual({
    ok: true,
    value: { displayName: null, activityPeriodDays: 30 },
  });
});

test("上限を超える表示名は切り詰めずに失敗として返す", () => {
  // 切り詰めて送ると、入力した値と保存された値が黙って食い違う（RULE-004）。
  expect(toSettingsInput({ displayName: "あ".repeat(41), activityPeriodDays: 30 })).toMatchObject({
    ok: false,
  });
});

test("画面で選べる期間は、すべて送信できる値である", () => {
  // 選べるのに保存できない設定を作らない。API 側の選択肢と同じ並びを保つ。
  for (const days of ACTIVITY_PERIOD_DAYS) {
    expect(isActivityPeriodDays(days)).toBe(true);
    expect(toSettingsInput({ displayName: "", activityPeriodDays: days })).toMatchObject({
      ok: true,
      value: { activityPeriodDays: days },
    });
  }
  expect(isActivityPeriodDays(31)).toBe(false);
});

/**
 * この語彙は `apps/api/src/contract/user-settings.ts` と対になっている。
 *
 * 別ワークスペースなので import では繋がらない。繋がらないまま片方だけ増やすと
 * 「画面で選べるのに保存できない設定」が生まれ、利用者には保存の失敗としてしか
 * 見えない。ソースを読んで値を突き合わせ、ずれたらここで落とす。
 */
test("API 側の契約と選択肢・上限が一致している", () => {
  const contract = readFileSync(
    new URL("../../../api/src/contract/user-settings.ts", import.meta.url),
    "utf8",
  );

  const periods = /export const ACTIVITY_PERIOD_DAYS = \[([^\]]*)\]/.exec(contract)?.[1];
  expect(periods, "API 側の ACTIVITY_PERIOD_DAYS を読めなかった").toBeDefined();
  expect(periods?.split(",").map((value) => Number(value.trim()))).toEqual([
    ...ACTIVITY_PERIOD_DAYS,
  ]);

  const maxLength = /export const DISPLAY_NAME_MAX_LENGTH = (\d+)/.exec(contract)?.[1];
  expect(maxLength, "API 側の DISPLAY_NAME_MAX_LENGTH を読めなかった").toBeDefined();
  expect(Number(maxLength)).toBe(DISPLAY_NAME_MAX_LENGTH);
});
