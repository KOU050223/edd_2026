import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  ACTIVITY_PERIOD_DAYS,
  DISPLAY_NAME_MAX_LENGTH,
  isActivityPeriodDays,
  sameSettings,
  toDraft,
  toSettingsInput,
  type UserSettings,
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

const savedSettings = (overrides: Partial<UserSettings> = {}): UserSettings => ({
  version: 1,
  displayName: "こう",
  activityPeriodDays: 30,
  updatedAt: "2026-09-22T00:00:00.000Z",
  ...overrides,
});

test("保存済みの設定を編集できる形へ写すと、未設定は空文字になる", () => {
  // 入力欄は null を持てない。表示名の「未設定」は空文字で表れる。
  expect(toDraft(savedSettings({ displayName: null }))).toEqual({
    displayName: "",
    activityPeriodDays: 30,
  });
});

test("読み込んだ値をそのまま写した直後は、変更なしと判定する", () => {
  const settings = savedSettings({ displayName: null });
  expect(sameSettings(settings, toDraft(settings))).toBe(true);
  expect(sameSettings(savedSettings(), toDraft(savedSettings()))).toBe(true);
});

test("値を変えると差分として検出する", () => {
  const settings = savedSettings();
  expect(sameSettings(settings, { displayName: "べつ", activityPeriodDays: 30 })).toBe(false);
  expect(sameSettings(settings, { displayName: "こう", activityPeriodDays: 7 })).toBe(false);
});

test("空白を足しただけは変更として数えない", () => {
  // 比較は正規化した後の値で行う。生の文字列で比べると、保存しても内容が
  // 変わらないのに保存ボタンだけが有効になる。
  expect(sameSettings(savedSettings(), { displayName: "  こう  ", activityPeriodDays: 30 })).toBe(
    true,
  );
  // 未設定に空白だけを入れた場合も同じ。
  expect(
    sameSettings(savedSettings({ displayName: null }), {
      displayName: "   ",
      activityPeriodDays: 30,
    }),
  ).toBe(true);
});

test("送れない値は「保存済みと同じ」に倒さない", () => {
  // 同じだと答えると保存ボタンが無効になり、利用者は何が悪いのかを知る手段を失う。
  expect(
    sameSettings(savedSettings(), {
      displayName: "あ".repeat(DISPLAY_NAME_MAX_LENGTH + 1),
      activityPeriodDays: 30,
    }),
  ).toBe(false);
  expect(sameSettings(savedSettings(), { displayName: "こう", activityPeriodDays: 31 })).toBe(
    false,
  );
});

test("設定項目が増えても、差分の判定を手で直さなくてよい", () => {
  // この判定は `sameSettings` の1か所に閉じ込めてある。画面側で
  // `a.x !== b.x || ...` と書いていると、項目を足したときに直し忘れても型が通り、
  // 増えた項目だけが「変えても保存ボタンが有効にならない」形で黙って壊れる。
  // ここでは、比較が UserSettings の内容に基づいていることを確かめる。
  const settings = savedSettings();
  const keys = Object.keys(toDraft(settings)) as (keyof ReturnType<typeof toDraft>)[];
  for (const key of keys) {
    const changed = { ...toDraft(settings) };
    if (key === "displayName") changed.displayName = "ちがう名前";
    else changed.activityPeriodDays = 90;
    expect(sameSettings(settings, changed), `${key} の変更が差分として出ていない`).toBe(false);
  }
});
