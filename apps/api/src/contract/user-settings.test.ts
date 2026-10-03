import { expect, test } from "vitest";
import { DEFAULT_USER_SETTINGS, validateUserSettings } from "./user-settings.js";

test("既定値は「一度も保存していない」を updatedAt: null で表す", () => {
  // 既定値に保存時刻を入れると、保存したことがあるかを呼び出し側が判別できない。
  expect(DEFAULT_USER_SETTINGS.updatedAt).toBeNull();
  expect(DEFAULT_USER_SETTINGS.displayName).toBeNull();
});

test("正しい本文を受理し、表示名を正規化する", () => {
  expect(validateUserSettings({ displayName: " こう ", activityPeriodDays: 90 })).toEqual({
    ok: true,
    value: { displayName: "こう", activityPeriodDays: 90 },
  });
  expect(validateUserSettings({ displayName: null, activityPeriodDays: 7 })).toEqual({
    ok: true,
    value: { displayName: null, activityPeriodDays: 7 },
  });
});

test("空白だけの表示名は未設定と同じ意味なので null へ寄せる", () => {
  expect(validateUserSettings({ displayName: "  ", activityPeriodDays: 30 })).toEqual({
    ok: true,
    value: { displayName: null, activityPeriodDays: 30 },
  });
});

test("判定できない値は既定値へ丸めず拒否する", () => {
  // フォールバックで失敗を隠さない（.agents/rules/rules.md RULE-004）。
  // 既定値へ落とすと、保存したつもりの値と実際の値が黙って食い違う。
  for (const payload of [
    null,
    "string",
    // 全項目省略は何も変更しない PUT になるため拒否する。
    {},
    { displayName: null, activityPeriodDays: 0 },
    { displayName: null, activityPeriodDays: 31 },
    { displayName: null, activityPeriodDays: "30" },
    { displayName: 1, activityPeriodDays: 30 },
    { displayName: "あ".repeat(41), activityPeriodDays: 30 },
  ]) {
    expect(validateUserSettings(payload), JSON.stringify(payload)).toMatchObject({ ok: false });
  }
});

test("上限ちょうどの表示名は受理する", () => {
  expect(
    validateUserSettings({ displayName: "あ".repeat(40), activityPeriodDays: 30 }),
  ).toMatchObject({
    ok: true,
  });
});

test("全項目が省略可能で、省略項目は出力へ含めない", () => {
  // 「1項目だけ直す」呼び出しが現在値を読み返す必要がないようにする
  // （Issue #204）。省略と現状維持の区別はキーの有無で担う。
  expect(validateUserSettings({ saveConversationHistory: true })).toEqual({
    ok: true,
    value: { saveConversationHistory: true },
  });
  expect(validateUserSettings({ displayName: null, activityPeriodDays: 30 })).toEqual({
    ok: true,
    value: { displayName: null, activityPeriodDays: 30 },
  });
  expect(
    validateUserSettings({
      displayName: null,
      activityPeriodDays: 30,
      saveConversationHistory: true,
    }),
  ).toEqual({
    ok: true,
    value: { displayName: null, activityPeriodDays: 30, saveConversationHistory: true },
  });
});

test("saveConversationHistory が真偽値でなければ拒否する", () => {
  for (const value of ["true", 1, null]) {
    expect(
      validateUserSettings({
        displayName: null,
        activityPeriodDays: 30,
        saveConversationHistory: value,
      }),
      JSON.stringify(value),
    ).toMatchObject({ ok: false });
  }
});
