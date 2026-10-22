// 進行中の回答生成を管理する状態（Issue #279 ステップ 6）。
// Electron に触れないので単体テストできる。同時送信の抑止は RULE-007 の要求で、
// renderer の isAsking は見た目の補助に過ぎず、main 側の入口でここが弾く。

export class AnswerInFlight {
  private controller: AbortController | undefined;

  /**
   * 新しい生成を始める。既に生成中なら例外（RULE-007）。
   * 返した signal の監視で利用者キャンセル・送信元破棄のどちらの中断も拾う。
   */
  begin(): AbortSignal {
    if (this.controller) {
      throw new Error("回答を生成しています。生成が終わってから送り直してください。");
    }
    this.controller = new AbortController();
    return this.controller.signal;
  }

  /** 実行中の生成を中断する。実行中でなければ何もしない。 */
  cancel(): void {
    this.controller?.abort();
  }

  /**
   * 生成の終了を記録し、次の送信を受け付けられるようにする。
   * 呼び出し側は必ず finally で呼ぶ。
   */
  finish(): void {
    this.controller = undefined;
  }
}
