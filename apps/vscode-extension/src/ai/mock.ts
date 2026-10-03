/**
 * 実 AI に接続せず固定文字列を返す Provider。
 *
 * UI ライン（質問/01 #13、表示/01 #14）が VSCodeLMProvider (#11) や
 * 調査/01 (#4) の完了を待たずに導線を組めるようにするためのもの。
 * デモ時の Fallback ではなく、開発中の既定実装として使う。
 */

import type { AIError, AIResponse } from "./types";
import type { AIProvider } from "./provider";

const MOCK_EXPLAIN_TEXT = [
  "【Explain】",
  "これは MockProvider の固定応答です。実際の AI には接続していません。",
  "",
  "選択されたコードの意味・なぜそう書くのか・どこを見るべきかを、",
  "ここに表示します。",
].join("\n");

/**
 * MockProvider のふるまいを外から差し込むための設定。
 *
 * 表示/01 (#14) はエラー表示とローディング表示も実装する必要があるが、
 * 成功しか返せない Mock ではそれを確認できない。テスト用の分岐を
 * Provider の内部に隠さず、呼び出し側が明示的に指定できるようにする。
 */
export interface MockProviderOptions {
  /** 応答までの待ち時間（ミリ秒）。ローディング表示の確認に使う。既定は 0。 */
  delayMs?: number;
  /** 指定するとその失敗を返す。エラー表示の確認に使う。 */
  failWith?: AIError;
}

export class MockProvider implements AIProvider {
  readonly id = "mock";

  constructor(private readonly options: MockProviderOptions = {}) {}

  async ask(): Promise<AIResponse> {
    const { delayMs = 0, failWith } = this.options;

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    if (failWith) {
      return { ok: false, error: failWith };
    }

    return {
      ok: true,
      answer: {
        text: MOCK_EXPLAIN_TEXT,
        // Concept の抽出は AI 側の仕事であり、Mock は推測しない。
        // 空配列でも学習イベントの記録が破綻しないことをここで確認できる。
        conceptIds: [],
        model: this.id,
      },
    };
  }
}
