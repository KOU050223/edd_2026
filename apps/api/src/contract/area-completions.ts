/**
 * `POST /v1/area-completions:check` の外部契約。
 *
 * 1 つの分野（Concept ID のプレフィックス）の Concept が**全件 確認済み**になったら
 * 「コンプリート」として記録する。判定はサーバーで行う。クライアントが
 * 「達成した」と申告する形にすると、記録が利用者の手で作れてしまう。
 *
 * **記録は消さない。** あとで Concept が増えてその分野が未達に戻っても、
 * 一度達成した事実は残す。消すと、達成の履歴が Concept 定義の都合で書き換わる。
 * 「いま全件 確認済みか」は導出できる値なので、そちらは記録と別に見ること。
 */

/** 読み取りモデルのスキーマバージョン。破壊的変更のときに上げる。 */
export const AREA_COMPLETIONS_RESPONSE_VERSION = 1;

export interface AreaCompletion {
  /** 分野。Concept ID のプレフィックス（言語とは限らない。docs/concepts.md）。 */
  language: string;
  /** 初めて全件 確認済みだと観測した時刻。ISO 8601。 */
  completedAt: string;
}

export interface AreaCompletionsResponse {
  version: number;
  /**
   * 達成した分野。古い順。
   *
   * 「コンプリート数」はこの配列の長さである。件数を別のフィールドで持たない。
   * 2 か所に持つと、片方だけ直し忘れたときに食い違う。
   */
  completions: AreaCompletion[];
  /**
   * この呼び出しで**初めて**記録した分野。
   *
   * クライアントはここに入っている分野だけを祝う。`completions` で祝うと、
   * 画面を開き直すたびに同じ達成を祝うことになる。
   */
  newlyCompleted: string[];
}
