/**
 * `GET` / `PUT /v1/user-settings` の外部契約。
 *
 * 学習イベントと違い、設定は追記ではなく**上書き**である。1ユーザー1件で、
 * 履歴を持たない。そのため冪等性のための ID もエンベロープも要らない。
 *
 * **載せる項目は、サーバーが今この瞬間に尊重できるものだけにする。**
 * 未実装の機能の欄を先に作らない（Issue #123）。空の欄は利用者から見れば
 * 「壊れている」と区別がつかず、保存しても何も起きないことが不具合の報告になる。
 */

/** 設定のスキーマバージョン。破壊的変更のときに上げる。 */
export const USER_SETTINGS_VERSION = 1;

/**
 * 表示名の最大長。
 *
 * 上限を置くのは、保存する前に拒否できる形にしておくため。無制限を許すと、
 * D1 の行サイズが利用者の入力で決まり、拒否の判断が保存の後ろ側へ移る。
 */
export const DISPLAY_NAME_MAX_LENGTH = 40;

/** `/activity` の期間切り替えと同じ選択肢。片方だけ増やさないこと。 */
export const ACTIVITY_PERIOD_DAYS = [7, 30, 90] as const;
export type ActivityPeriodDays = (typeof ACTIVITY_PERIOD_DAYS)[number];

export interface UserSettings {
  version: number;
  /**
   * 画面に出す表示名。未設定は `null`。
   *
   * 空文字を「未設定」に使わない。「未設定」と「空文字を保存した」が
   * 区別できなくなり、消すつもりの操作と保存するつもりの操作が同じ値になる。
   */
  displayName: string | null;
  /** `/activity` を開いたときの既定の期間（日）。 */
  activityPeriodDays: ActivityPeriodDays;
  /**
   * 「質問履歴の保存」オプトイン（Issue #204）。
   *
   * 有効な場合だけ `PUT /v1/conversations/:id` が本文を保存する。
   * サーバー側でも判定するのは、クライアントが持つ値が古くても
   * オプトイン無しの本文が保存されないようにするため
   * （docs/conversation-history.md「二重のゲート」）。
   */
  saveConversationHistory: boolean;
  /** 最後に保存した時刻。ISO 8601。一度も保存していなければ `null`。 */
  updatedAt: string | null;
}

/** 一度も保存していないユーザーへ返す既定値。 */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  version: USER_SETTINGS_VERSION,
  displayName: null,
  activityPeriodDays: 30,
  saveConversationHistory: false,
  updatedAt: null,
};

export function isActivityPeriodDays(value: unknown): value is ActivityPeriodDays {
  return typeof value === "number" && ACTIVITY_PERIOD_DAYS.includes(value as ActivityPeriodDays);
}

/**
 * `PUT` が受け取る本文。保存する値だけを持ち、`updatedAt` はサーバーが決める。
 *
 * `saveConversationHistory` だけ省略可能にする。他項目は上書きの対象として
 * 常に入力が必要だが、この項目は「履歴を保存するか」の切り替えだけをしたい
 * 呼び出しが表示名などを持たないため。省略されたときは保存済みの値を維持する
 * （上書きで黙って `false` に戻さない。ルート側が現在値とマージしてから書く）。
 */
export interface UserSettingsInput {
  displayName: string | null;
  activityPeriodDays: ActivityPeriodDays;
  saveConversationHistory?: boolean;
}

export type SettingsValidation =
  { ok: true; value: UserSettingsInput } | { ok: false; message: string };

/**
 * 受け取った本文を検証する。
 *
 * **判定できない値は拒否に倒す。** 既定値へ黙って落とすと、利用者が保存したつもりの
 * 値と実際に保存された値が食い違い、しかもそれが画面のどこにも出ない
 * （.agents/rules/rules.md RULE-004「フォールバックで失敗を隠さない」）。
 *
 * 表示名の前後の空白は落とす。空白だけの入力は「未設定」と同じ意味なので
 * `null` へ寄せる。これは失敗を隠すフォールバックではなく、
 * 同じ意味の2つの表現を1つへ正規化する操作である。
 */
export function validateUserSettings(payload: unknown): SettingsValidation {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, message: "invalid request body" };
  }
  const { displayName, activityPeriodDays, saveConversationHistory } = payload as {
    displayName?: unknown;
    activityPeriodDays?: unknown;
    saveConversationHistory?: unknown;
  };

  if (displayName !== null && typeof displayName !== "string") {
    return { ok: false, message: "displayName must be a string or null" };
  }
  const trimmed = typeof displayName === "string" ? displayName.trim() : null;
  if (trimmed !== null && trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `displayName must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
    };
  }

  if (!isActivityPeriodDays(activityPeriodDays)) {
    return {
      ok: false,
      message: `activityPeriodDays must be one of ${ACTIVITY_PERIOD_DAYS.join(", ")}`,
    };
  }

  if (saveConversationHistory !== undefined && typeof saveConversationHistory !== "boolean") {
    return { ok: false, message: "saveConversationHistory must be a boolean" };
  }

  return {
    ok: true,
    value: {
      displayName: trimmed === null || trimmed.length === 0 ? null : trimmed,
      activityPeriodDays,
      ...(saveConversationHistory === undefined ? {} : { saveConversationHistory }),
    },
  };
}
