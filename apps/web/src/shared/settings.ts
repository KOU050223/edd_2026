/**
 * ユーザー設定の語彙。`apps/api/src/contract/user-settings.ts` と対になる。
 *
 * 画面で選べる値と、API が受け付ける値を別々に育てない。片方だけ増やすと
 * 「選べるのに保存できない設定」が生まれ、利用者には保存の失敗としてしか見えない。
 * 増やすときは両方を直すこと。
 */

export const DISPLAY_NAME_MAX_LENGTH = 40;

/** `/activity` の期間切り替えと同じ選択肢。 */
export const ACTIVITY_PERIOD_DAYS = [7, 30, 90] as const;
export type ActivityPeriodDays = (typeof ACTIVITY_PERIOD_DAYS)[number];

export interface UserSettings {
  version: number;
  /** 未設定は `null`。空文字は使わない。 */
  displayName: string | null;
  activityPeriodDays: ActivityPeriodDays;
  /** 一度も保存していなければ `null`。 */
  updatedAt: string | null;
}

export function isActivityPeriodDays(value: unknown): value is ActivityPeriodDays {
  return typeof value === "number" && ACTIVITY_PERIOD_DAYS.includes(value as ActivityPeriodDays);
}

/** API から受け取った設定が、画面で安全に扱える形か検証する。 */
export function isUserSettings(value: unknown): value is UserSettings {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as Record<string, unknown>;
  const displayName = settings.displayName;
  return (
    settings.version === 1 &&
    (displayName === null ||
      (typeof displayName === "string" && displayName.length <= DISPLAY_NAME_MAX_LENGTH)) &&
    isActivityPeriodDays(settings.activityPeriodDays) &&
    (settings.updatedAt === null || typeof settings.updatedAt === "string")
  );
}

/** `PUT` へ送る本文。`updatedAt` はサーバーが決めるので送らない。 */
export interface UserSettingsInput {
  displayName: string | null;
  activityPeriodDays: ActivityPeriodDays;
}

/**
 * 編集中の値。画面の入力欄と1対1で対応する。
 *
 * 保存済みの `UserSettings` と別の型にする。入力欄は文字列しか持てないので、
 * 表示名の「未設定」は `null` ではなく空文字で表れる。同じ型で兼ねると、
 * どちらの表現なのかが読む場所によって変わる。
 */
export interface SettingsDraft {
  displayName: string;
  activityPeriodDays: number;
}

/** 保存済みの設定を、編集できる形へ写す。 */
export function toDraft(settings: UserSettings): SettingsDraft {
  return {
    displayName: settings.displayName ?? "",
    activityPeriodDays: settings.activityPeriodDays,
  };
}

/**
 * 編集中の値が、保存済みの設定と同じ内容かを返す。
 *
 * **項目ごとの比較をこの1か所に閉じ込める。** 画面側で
 * `saved.displayName !== draft.displayName || ...` と書くと、設定項目が増えるたびに
 * その式を直す必要があり、**直し忘れても型は通る**。増えた項目だけが
 * 「変更しても保存ボタンが有効にならない」という形で黙って壊れる。
 *
 * 比較は正規化した後の値で行う。`toSettingsInput` が前後の空白を落とすので、
 * 生の文字列で比べると「空白を足しただけ」が変更として数えられ、
 * 保存しても内容が変わらないのに保存ボタンが有効になる。
 */
export function sameSettings(settings: UserSettings, draft: SettingsDraft): boolean {
  const input = toSettingsInput(draft);
  // 送れない値は「保存済みと同じ」ではない。同じだと答えると保存ボタンが無効になり、
  // 利用者は入力を直すまで何が悪いのかを知る手段を失う。
  if (!input.ok) return false;
  return (
    input.value.displayName === settings.displayName &&
    input.value.activityPeriodDays === settings.activityPeriodDays
  );
}

/**
 * 画面の入力値を、送信できる形へ整える。
 *
 * 送信の直前に**画面の状態そのもの**から作る。別に持った変数から組み立てると、
 * 保存した設定を送信内容へ反映し忘れる（.agents/rules/rules.md RULE-007 の
 * 「画面の状態と実際に送る要求を一致させる」）。
 *
 * 上限超過はここで失敗として返す。切り詰めて送ると、利用者が入力した値と
 * 保存された値が黙って食い違う（RULE-004「フォールバックで失敗を隠さない」）。
 */
export type SettingsDraftResult =
  { ok: true; value: UserSettingsInput } | { ok: false; message: string };

export function toSettingsInput(draft: SettingsDraft): SettingsDraftResult {
  const trimmed = draft.displayName.trim();
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH)
    return { ok: false, message: `表示名は ${DISPLAY_NAME_MAX_LENGTH} 文字までです` };
  if (!isActivityPeriodDays(draft.activityPeriodDays))
    return { ok: false, message: "表示期間の選択が不正です" };
  return {
    ok: true,
    value: {
      displayName: trimmed.length === 0 ? null : trimmed,
      activityPeriodDays: draft.activityPeriodDays,
    },
  };
}
