// 送信同意の記録と確認ダイアログ（Issue #279 ステップ 3 で index.ts から分離）。
// 文面と版は @gakushu-sochi/domain の consent.ts が正本。
import { app, dialog } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CONSENT_NOTICE_DETAIL, CONSENT_NOTICE_TITLE } from "@gakushu-sochi/domain";

import { appState } from "./app-state.js";
import { createConsentStore } from "./consent.js";

/**
 * 同意の記録は `userData` 直下の専用ファイルへ置く。settings.json に混ぜると
 * `settings:save` の経路から同意を偽装できてしまう（RULE-006 / consent.ts）。
 */
export function consentStore() {
  const filePath = path.join(app.getPath("userData"), "consent.json");
  return createConsentStore({
    read: () => (existsSync(filePath) ? readFileSync(filePath, "utf8") : ""),
    write: (value) => writeFileSync(filePath, value, { encoding: "utf8", mode: 0o600 }),
  });
}

/**
 * 同意済みであることを確かめる。未同意なら文面を提示して同意を求める。
 *
 * @returns 送信してよいか。false のとき、呼び出し側は送信せずに戻ること。
 *          記録の保存に失敗した場合は例外を投げ、送信を中止させる。
 */
export async function ensureConsent(): Promise<boolean> {
  if (consentStore().has()) return true;

  const options = {
    type: "warning" as const,
    title: CONSENT_NOTICE_TITLE,
    message: CONSENT_NOTICE_TITLE,
    detail: CONSENT_NOTICE_DETAIL,
    buttons: ["同意して続ける", "同意しない"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const result = appState.popup
    ? await dialog.showMessageBox(appState.popup, options)
    : await dialog.showMessageBox(options);
  if (result.response !== 0) return false;

  // 記録できないまま送ると、同意の証跡が無いまま送信を続けることになる。
  // 失敗は呼び出し側へ投げて、今回は送らない（RULE-004）。
  consentStore().grant(new Date().toISOString());
  return true;
}

/**
 * 同意の状態と文面を利用者が読み返せるようにする。同意済みなら取り消せる。
 *
 * すでに送ったデータの削除はここでは行わない。止まるのは「これから送るもの」
 * だけであることを利用者へ明示する。
 */
export async function reviewConsent(): Promise<void> {
  if (!consentStore().has()) {
    await ensureConsent();
    return;
  }

  const options = {
    type: "info" as const,
    title: CONSENT_NOTICE_TITLE,
    message: CONSENT_NOTICE_TITLE,
    detail: `${CONSENT_NOTICE_DETAIL}\n\n現在、送信に同意しています。`,
    buttons: ["同意を取り消す", "閉じる"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const result = appState.popup
    ? await dialog.showMessageBox(appState.popup, options)
    : await dialog.showMessageBox(options);
  if (result.response !== 0) return;

  try {
    consentStore().revoke();
  } catch (error) {
    // 取り消せていないのに「取り消しました」と伝えると、送信が続いていることに
    // 利用者が気付けない。黙って飲み込まず、失敗として伝える（RULE-004）。
    console.error("同意の取り消しに失敗しました", error);
    dialog.showErrorBox(
      "同意を取り消せませんでした",
      "送信は停止していません。もう一度お試しください。",
    );
    return;
  }
  await dialog.showMessageBox({
    type: "info",
    message: "送信の同意を取り消しました。",
    detail: "以降の送信は行いません。すでに送信済みのデータの削除は含みません。",
    buttons: ["閉じる"],
    noLink: true,
  });
}
