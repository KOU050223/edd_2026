/**
 * `GET /v1/conversations/:id/learning-events` の外部契約（Web/15 #233）。
 *
 * 質問履歴の1件に対して、その会話で記録された学習イベントが、どの Concept のどの
 * 「理解すること」をどれだけ動かしたかを返す。会話と学習イベントは `sessionId` で結ぶ
 * （VS Code は会話 ID に学習イベントの `sessionId` を流用している。#212 / #225）。
 *
 * learning-profile と同じく生ログは返さず、表示に要る導出済みの値だけを返す。
 */

import type { ConceptId, LearningEventType } from "@gakushu-sochi/domain";

/** 読み取りモデルのスキーマバージョン。破壊的変更のときに上げる。 */
export const CONVERSATION_LEARNING_EVENTS_RESPONSE_VERSION = 1;

/** 1つの「理解すること」が、そのイベントでいくつからいくつへ動いたか。 */
export interface ObjectiveChangeView {
  conceptId: ConceptId;
  /** Concept の表示名。Concept 一覧に無い ID の場合は `undefined`。 */
  conceptLabel?: string;
  objectiveId: string;
  objectiveLabel: string;
  /** 0〜1。頭打ちなどで動かなかった項目は `before === after`。 */
  before: number;
  after: number;
}

/** 項目を動かした（触れた）学習イベント1件。 */
export interface ConversationLearningEventView {
  id: string;
  type: LearningEventType;
  occurredAt: string;
  changes: ObjectiveChangeView[];
}

export interface ConversationLearningEventsResponse {
  version: typeof CONVERSATION_LEARNING_EVENTS_RESPONSE_VERSION;
  /**
   * 発生時刻順。項目の情報を持たないイベント（`answer_viewed`、#223 より前のイベント、
   * AI が項目を特定できなかった質問など）は含めない。
   */
  events: ConversationLearningEventView[];
}
