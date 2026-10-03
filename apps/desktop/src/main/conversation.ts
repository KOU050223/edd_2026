import { deriveConversationTitle, type Conversation } from "@gakushu-sochi/domain";

/**
 * `answer:ask` の1往復から `PUT /v1/conversations/:id` へ送る会話を組み立てる。
 *
 * 設計の正本は docs/conversation-history.md。メッセージは
 * `context`（選択テキスト）→ `user`（質問）→ `assistant`（回答）の3件固定で、
 * 上限は `/v1/ai/responses` の入力上限（selection 20,000 / question 4,000）と
 * 揃うため、ここでは追加の切り詰めをしない。
 */
export interface BuildConversationInput {
  /** クライアント採番の会話 ID（UUID）。 */
  id: string;
  /** 利用者が入力したままの質問。タイトルの材料にする（既定文は差別化にならない）。 */
  userQuestion: string;
  /** AI へ送った正規化済みの質問文。 */
  question: string;
  selection: string;
  /** ストリームで受け取った回答本文。 */
  answer: string;
  /** 質問を始めた時刻（ISO 8601）。 */
  occurredAt: string;
  /** 最後の回答 delta を受け取った時刻（ISO 8601）。 */
  answeredAt: string;
  /** 回答が最後まで届いたか。途中で途切れたなら false。 */
  complete: boolean;
}

export function buildConversation(input: BuildConversationInput): Conversation {
  return {
    id: input.id,
    origin: "desktop",
    // 既定の質問文はどの会話も同じ先頭になるため、未入力のときは
    // 選択テキストの先頭行をタイトルにする。
    title: deriveConversationTitle(input.userQuestion) ?? deriveConversationTitle(input.selection),
    occurredAt: input.occurredAt,
    updatedAt: input.answeredAt,
    complete: input.complete,
    messages: [
      { role: "context", text: input.selection, at: input.occurredAt },
      { role: "user", text: input.question, at: input.occurredAt },
      { role: "assistant", text: input.answer, at: input.answeredAt },
    ],
  };
}
