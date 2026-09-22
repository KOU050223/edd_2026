/**
 * 推移画面の「どの期間を見せるか」の判断。
 *
 * 描画から切り離してある。ルートの `validateSearch` / `loader` に直接書くと、
 * jsdom も `@testing-library` も無いこのワークスペースでは検証できない
 * （`apps/web/AGENTS.md`）。
 */

import { isActivityPeriodDays, type ActivityPeriodDays } from "../shared/settings.js";

/**
 * URL の検索パラメータから期間を読む。
 *
 * 利用者は URL を手で書き換えられるので、知らない値は**黙って捨てる**。
 * ここで既定値へ倒さないのは、「URL に指定が無い」と「URL の指定が不正」を
 * 呼び出し側が区別する必要がないため。どちらも「指定なし」として扱えば、
 * 既定値の決定は一箇所（設定の読み込み）に集まる。
 */
export function parsePeriodSearch(search: Record<string, unknown>): { days?: ActivityPeriodDays } {
  // `Number(undefined)` は `NaN`、`Number("")` と `Number(null)` は `0` になる。
  // どれも選択肢に無いので型ガードが弾く。
  const value = Number(search.days);
  return isActivityPeriodDays(value) ? { days: value } : {};
}

/**
 * URL の指定と保存された設定から、実際に使う期間を決める。
 *
 * URL が優先。指定が無いときだけ設定を読む（`loadDefault`）。
 * 常に設定を読むと、URL で期間を指定した利用者にも余計な要求が飛ぶ。
 */
export async function resolvePeriod(
  fromSearch: ActivityPeriodDays | undefined,
  loadDefault: () => Promise<ActivityPeriodDays>,
): Promise<ActivityPeriodDays> {
  return fromSearch ?? (await loadDefault());
}
