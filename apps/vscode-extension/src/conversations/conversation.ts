import {
  deriveConversationTitle,
  type CodeContext,
  type Conversation,
  type ConversationMessage,
} from "@gakushu-sochi/domain";

/**
 * 1回の質問から `PUT /v1/conversations/:id` へ送る会話を組み立てる（Issue #204）。
 *
 * 設計の正本は docs/conversation-history.md。保存するのは
 * 「選択テキスト + 言語/ファイルのメタ情報 + 質問 + 回答」だけで、
 * AI が実際に見た周辺コード・定義・diagnostics は含めない。
 * 会話 ID には LearningEvent と同じ sessionId を使い、イベントと履歴を結べるようにする。
 */
export interface BuildVscodeConversationInput {
  /** persistEvent と同じ sessionId を渡す。 */
  id: string;
  context: CodeContext;
  question: string;
  answer: string;
  /** 質問を AI へ送った時刻（ISO 8601）。 */
  occurredAt: string;
  /** 回答を受け取った時刻（ISO 8601）。 */
  answeredAt: string;
  /** 端末の ID（getOrCreateClientId）。 */
  clientId?: string;
}

export function buildVscodeConversation(input: BuildVscodeConversationInput): Conversation {
  const messages: ConversationMessage[] = [];
  // code が空の経路（稀）で context メッセージを作ると契約の minLength(1) に
  // 触れるため、その場合は context を省く。
  if (input.context.code.length > 0) {
    messages.push({ role: "context", text: input.context.code, at: input.occurredAt });
  }
  messages.push(
    { role: "user", text: input.question, at: input.occurredAt },
    { role: "assistant", text: input.answer, at: input.answeredAt },
  );
  return {
    id: input.id,
    origin: "vscode",
    ...(input.clientId ? { clientId: input.clientId } : {}),
    // 質問が空白だけの場合は選択テキストの先頭行をタイトルにする。
    title: deriveConversationTitle(input.question) ?? deriveConversationTitle(input.context.code),
    ...(input.context.languageId ? { language: input.context.languageId } : {}),
    ...(input.context.fileName ? { fileName: input.context.fileName } : {}),
    occurredAt: input.occurredAt,
    updatedAt: input.answeredAt,
    // aiResponse.ok のあとに呼ばれるため、ここへ来る会話は回答完結済み。
    complete: true,
    messages,
  };
}
