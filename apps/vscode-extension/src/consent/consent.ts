/**
 * 送信同意の記録と確認（#119）。
 *
 * この拡張が外部へ何かを送る経路は、すべてここを通してから送る。
 * 記録は `globalState` に置く。設定（`contributes.configuration`）には置かない。
 * 設定はワークスペースから上書きでき、開いたリポジトリが同意を偽装できてしまう
 * （RULE-006）。`globalState` は利用者の端末にしか無く、リポジトリから触れない。
 *
 * 文面と版は `@gakushu-sochi/domain` の consent.ts が正本で、
 * Desktop / Web と同じ内容を提示できるようにしてある。
 */

import * as vscode from "vscode";
import {
  CONSENT_NOTICE_DETAIL,
  CONSENT_NOTICE_TITLE,
  createConsentRecord,
  isConsentGranted,
} from "@gakushu-sochi/domain";

/** globalState 上のキー。 */
export const CONSENT_KEY = "gakushuSochi.consent";

/** 同意ダイアログの選択肢。 */
const AGREE = "同意して続ける";
const DECLINE = "同意しない";

/**
 * 保存済みの同意を読む。
 *
 * **毎回読み直す。** 起動時に読んで持ち回ると、取り消しが次回起動まで効かない。
 * globalState の読み出しは同期でコストも小さいので、送信のたびに見てよい。
 */
export function hasConsent(context: vscode.ExtensionContext): boolean {
  return isConsentGranted(context.globalState.get<unknown>(CONSENT_KEY));
}

/**
 * 同意の記録を保存する。
 *
 * **保存に失敗したら同意が成立していない。** 成功として扱うと、次回起動時に
 * 記録が無く、利用者から見れば「同意したのにまた聞かれる」か、悪くすれば
 * 記録の無いまま送信が続く。失敗は呼び出し側へ返して止める（RULE-004）。
 */
async function saveConsent(context: vscode.ExtensionContext, grantedAt: string): Promise<void> {
  await context.globalState.update(CONSENT_KEY, createConsentRecord(grantedAt));
}

/**
 * 同意済みであることを確かめる。未同意なら文面を提示して同意を求める。
 *
 * @returns 送信してよいか。false のとき、呼び出し側は送信せずに戻ること。
 */
export async function ensureConsent(
  context: vscode.ExtensionContext,
  onError: (message: string) => void,
): Promise<boolean> {
  if (hasConsent(context)) {
    return true;
  }

  const answer = await vscode.window.showWarningMessage(
    CONSENT_NOTICE_TITLE,
    { modal: true, detail: CONSENT_NOTICE_DETAIL },
    AGREE,
    DECLINE,
  );

  if (answer !== AGREE) {
    return false;
  }

  try {
    await saveConsent(context, new Date().toISOString());
  } catch (error) {
    // 記録できないまま送ると、次回また同意を求めることになるか、
    // 同意の証跡が無いまま送信を続けることになる。どちらも避けて、今回は送らない。
    onError(`同意の記録に失敗しました: ${String(error)}`);
    vscode.window.showErrorMessage(
      "同意を記録できなかったため送信を中止しました。しばらくしてからもう一度お試しください。",
    );
    return false;
  }

  return true;
}

/**
 * 同意を取り消す。以降 `hasConsent` は false になり、送信は止まる。
 *
 * すでに送ったデータの削除はここでは行わない（#79 が持つ）。
 * 止まるのは「これから送るもの」だけであることを利用者へ明示する。
 */
export async function revokeConsent(
  context: vscode.ExtensionContext,
  onError: (message: string) => void,
): Promise<void> {
  try {
    await context.globalState.update(CONSENT_KEY, undefined);
  } catch (error) {
    // 取り消せていないのに「取り消しました」と伝えると、送信が続いていることに
    // 利用者が気付けない。黙って飲み込まず、失敗として伝える。
    onError(`同意の取り消しに失敗しました: ${String(error)}`);
    vscode.window.showErrorMessage(
      "同意を取り消せませんでした。送信は停止していません。もう一度お試しください。",
    );
    return;
  }

  vscode.window.showInformationMessage(
    "送信の同意を取り消しました。以降の送信は行いません。すでに送信済みのデータの削除は含みません。",
  );
}

/** 現在の同意状態と、提示している文面を利用者が読み返せるようにする。 */
export async function reviewConsent(
  context: vscode.ExtensionContext,
  onError: (message: string) => void,
): Promise<void> {
  if (!hasConsent(context)) {
    await ensureConsent(context, onError);
    return;
  }

  const answer = await vscode.window.showInformationMessage(
    CONSENT_NOTICE_TITLE,
    { modal: true, detail: `${CONSENT_NOTICE_DETAIL}\n\n現在、送信に同意しています。` },
    "同意を取り消す",
  );

  if (answer === "同意を取り消す") {
    await revokeConsent(context, onError);
  }
}
