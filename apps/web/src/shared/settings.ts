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

/** `PUT` へ送る本文。`updatedAt` はサーバーが決めるので送らない。 */
export interface UserSettingsInput {
  displayName: string | null;
  activityPeriodDays: ActivityPeriodDays;
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

export function toSettingsInput(draft: {
  displayName: string;
  activityPeriodDays: number;
}): SettingsDraftResult {
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
