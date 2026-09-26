/**
 * `/v1/conversations` の外部契約（Issue #204）。
 *
 * 質問文・選択テキスト・AI の回答の本文を保存するため、LearningEvent と
 * 別のリソースにする。設計の正本は docs/conversation-history.md。
 *
 * 契約はこのアプリに置く（apps/api/AGENTS.md）。packages/domain の
 * `Conversation` 型を使うが、このファイルのレスポンス型を
 * 他パッケージから参照させない。
 */

import * as v from "valibot";
import {
  CONVERSATION_ORIGINS,
  CONVERSATION_TITLE_MAX_LENGTH,
  isIsoDateTime,
  type Conversation,
  type ConversationMessageRole,
} from "@gakushu-sochi/domain";

/** ID の最大長。learning-event と同じ上限。 */
const MAX_ID_LENGTH = 128;

/** 1会話あたりのメッセージ最大件数。 */
export const MAX_MESSAGES_PER_CONVERSATION = 50;

/**
 * メッセージ本文の上限。役割ごとに既存の入力上限へ揃える
 * （apps/api/src/routes/ai.ts の selection / question 上限と同じ根拠）。
 * assistant は Managed AI の maxTokens が産む長さを十分に覆う上限。
 */
export const MAX_MESSAGE_TEXT_LENGTH: Record<ConversationMessageRole, number> = {
  context: 20_000,
  user: 4_000,
  assistant: 100_000,
};

/** 1会話に含める本文の合計上限。メッセージ件数と各上限の積が不用意に大きくならないよう別途絞る。 */
export const MAX_CONVERSATION_TOTAL_TEXT_LENGTH = 256_000;

/**
 * ISO 8601 の時刻として解釈できることを要求する。
 *
 * learning-event と同じく `isIsoDateTime` に委ねる。一覧の並び替えは
 * `updated_at_ms`（数値）で行うため、パースできない文字列を通すと
 * 永続的に一覧から外れる行ができる。
 */
const isoDateTimeSchema = v.pipe(
  v.string(),
  v.check(isIsoDateTime, "must be an ISO 8601 date-time with a UTC or numeric offset"),
);

const messageSchema = v.pipe(
  v.strictObject({
    role: v.picklist(["context", "user", "assistant"]),
    text: v.pipe(v.string(), v.minLength(1)),
    at: isoDateTimeSchema,
  }),
  // 役割ごとの上限。コンテキストとして質問本文サイズを受け入れたりすると
  // 「選択テキストしか保存しない」という設計上の約束が実質的に崩れる。
  v.check(
    (message) => message.text.length <= MAX_MESSAGE_TEXT_LENGTH[message.role],
    "text exceeds the limit for its role",
  ),
);

/**
 * `PUT /v1/conversations/:id` が受け取る会話。
 *
 * `strictObject` は本文以外のキーを黙って捨てないためである。learning-event と
 * 同じく、送った側が「保存された」と誤解したまま気づかない状態を作らない。
 */
export const conversationSchema = v.pipe(
  v.strictObject({
    id: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ID_LENGTH)),
    origin: v.picklist(CONVERSATION_ORIGINS),
    clientId: v.optional(v.pipe(v.string(), v.maxLength(MAX_ID_LENGTH))),
    title: v.optional(v.pipe(v.string(), v.maxLength(CONVERSATION_TITLE_MAX_LENGTH))),
    language: v.optional(v.pipe(v.string(), v.maxLength(64))),
    fileName: v.optional(v.pipe(v.string(), v.maxLength(512))),
    occurredAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    complete: v.boolean(),
    messages: v.pipe(
      v.array(messageSchema),
      v.minLength(1),
      v.maxLength(MAX_MESSAGES_PER_CONVERSATION),
      v.check(
        (messages) =>
          messages.reduce((total, m) => total + m.text.length, 0) <=
          MAX_CONVERSATION_TOTAL_TEXT_LENGTH,
        "total message text exceeds the limit",
      ),
    ),
  }),
);

/** `PUT` の応答。`newer_exists` は既存行のほうが新しいため書き換えなかった場合。 */
export interface PutConversationResponse {
  saved: boolean;
  reason?: "newer_exists";
}

/**
 * 一覧が返す要約。本文（`messages`）は含めない。
 *
 * サイドバーの一覧を軽く保つことと、一覧を開くだけで全件の本文が
 * クライアントへ出ないようにすることが目的である。
 */
export interface ConversationSummary {
  id: string;
  origin: string;
  clientId?: string;
  title?: string;
  language?: string;
  fileName?: string;
  occurredAt: string;
  updatedAt: string;
  messageCount: number;
  complete: boolean;
}

/** `GET /v1/conversations` の応答。`nextCursor` が null なら末尾まで読んだ。 */
export interface ListConversationsResponse {
  conversations: ConversationSummary[];
  nextCursor: string | null;
}

/** `DELETE /v1/conversations(/:id)` の応答。 */
export interface DeleteConversationsResponse {
  deletedCount: number;
}

/** `GET /v1/conversations:export` の応答。 */
export interface ConversationExport {
  version: 1;
  exportedAt: string;
  conversations: Conversation[];
}

/** 一覧の既定ページサイズと上限。 */
export const CONVERSATIONS_DEFAULT_LIMIT = 50;
export const CONVERSATIONS_MAX_LIMIT = 100;

/**
 * カーソルの符号化。`{updatedAtMs}_{id}` という形にする。
 *
 * `updatedAtMs` は数字だけなので、最初の `_` だけで切り分けられる。
 * `id` はクライアント採番で任意の文字を含みうるため、区切り文字を
 * 含まない側から先に切る。
 */
export function encodeConversationCursor(row: ConversationSummary): string {
  return `${Date.parse(row.updatedAt)}_${row.id}`;
}

/**
 * カーソルを `{updatedAtMs, id}` へ戻す。解釈できない形は `null` を返す。
 * 呼び出し側は `null` を 400 にする。黙って先頭ページへ戻すと、
 * 利用者には壊れた遷移に見える（RULE-004）。
 */
export function parseConversationCursor(
  cursor: string,
): { updatedAtMs: number; id: string } | null {
  const separator = cursor.indexOf("_");
  if (separator <= 0 || separator === cursor.length - 1) return null;
  const updatedAtMs = Number(cursor.slice(0, separator));
  if (!Number.isSafeInteger(updatedAtMs)) return null;
  return { updatedAtMs, id: cursor.slice(separator + 1) };
}
