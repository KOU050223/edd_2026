/**
 * 保存した確認問題を使い回してよいかの判定（#185）。
 *
 * ## 作り直す条件
 *
 * 保存した1組は、次のどちらかが変わったら古いものとして扱い、生成し直して上書きする。
 *
 * 1. **生成に使ったプロンプト。** プロンプトは Concept の `label` / `summary` /
 *    前提 / 次に接続する Concept と、出題の方針・出力形式・文字数の上限（`CHECK_LIMITS`）から
 *    組み立てる（`prompt.ts`）。全文の SHA-256 を保存しておけば、どれが変わっても検出できる。
 *    個々の項目を列に分けて比べないのは、プロンプトに載せる項目を増やしたときに
 *    比較の側を直し忘れると、定義が変わっても古い問題が出続けるため。
 * 2. **{@link CHECK_FORMAT_VERSION}。** プロンプトに現れない受理側の規則
 *    （`response.ts` の検証の強化、保存する形の変更）を変えたときに手で上げる。
 *
 * 「次に接続する Concept」が増えただけでも作り直しになる。プロンプトの入力である以上、
 * 問題の範囲（次の Concept を出題しない）が変わりうるので、それで正しい。
 * 作り直しても 1 Concept 1回の生成で済む。
 *
 * 生成時刻による期限は設けない。定義が変わらない限り、同じ問題を出し続けることが
 * 出題の安定（`check_failed` の減点が問題の当たり外れで入らないこと）になる。
 */

import type { StoredConceptCheck } from "../repository/types.js";

/**
 * 受理側の規則の版。プロンプトの文面を変えずに、検証や保存の形を変えたときに上げる。
 *
 * プロンプトを変えたときは上げなくてよい（ハッシュが変わる）。
 */
export const CHECK_FORMAT_VERSION = 1;

/** プロンプト全文の SHA-256 を16進で返す。Workers と Node の両方に Web Crypto がある。 */
export async function promptSha256(prompt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prompt));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 保存済みの1組を、今のプロンプトに対してそのまま出題してよいか。 */
export function isCurrent(stored: StoredConceptCheck, currentPromptSha256: string): boolean {
  return (
    stored.formatVersion === CHECK_FORMAT_VERSION && stored.promptSha256 === currentPromptSha256
  );
}
