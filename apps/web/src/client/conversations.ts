/**
 * 質問履歴の閲覧・エクスポート・削除（Issue #206）。
 *
 * 契約の正本は `apps/api/src/contract/conversations.ts`。ここでは再定義せず、
 * 応答の形だけを検証する。2xx でも形が違えば失敗として扱う（RULE-004）。
 *
 * Web は会話のコピーを持たない（docs/data-privacy.md「クライアント側に残る
 * コピー」）ため、取得した値は表示とダウンロードへ流すだけで、
 * localStorage などへ残さない。
 */

import { CONVERSATION_ORIGINS, type Conversation } from "@gakushu-sochi/domain";
import { ApiError, deleteJson, requestJson } from "./api.js";

export const CONVERSATIONS_PATH = "/api/v1/conversations";
export const CONVERSATIONS_EXPORT_PATH = "/api/v1/conversations:export";

const MESSAGE_ROLES = ["context", "user", "assistant"] as const;

/**
 * `GET /v1/conversations` の応答要素
 * （apps/api/src/contract/conversations.ts の `ConversationSummary` と対応）。
 * 本文（`messages`）は一覧には含まれない。
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

export interface ListConversationsResult {
  conversations: ConversationSummary[];
  /** 末尾まで読んだら `null`。 */
  nextCursor: string | null;
}

function isConversationSummary(value: unknown): value is ConversationSummary {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Record<string, unknown>;
  return (
    typeof summary.id === "string" &&
    typeof summary.origin === "string" &&
    (summary.title === undefined || typeof summary.title === "string") &&
    (summary.language === undefined || typeof summary.language === "string") &&
    (summary.fileName === undefined || typeof summary.fileName === "string") &&
    typeof summary.occurredAt === "string" &&
    typeof summary.updatedAt === "string" &&
    typeof summary.messageCount === "number" &&
    typeof summary.complete === "boolean"
  );
}

function isConversationMessage(value: unknown): value is Conversation["messages"][number] {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    MESSAGE_ROLES.includes(message.role as (typeof MESSAGE_ROLES)[number]) &&
    typeof message.text === "string" &&
    typeof message.at === "string"
  );
}

export function isConversation(value: unknown): value is Conversation {
  if (typeof value !== "object" || value === null) return false;
  const conversation = value as Record<string, unknown>;
  return (
    typeof conversation.id === "string" &&
    CONVERSATION_ORIGINS.includes(conversation.origin as (typeof CONVERSATION_ORIGINS)[number]) &&
    typeof conversation.occurredAt === "string" &&
    typeof conversation.updatedAt === "string" &&
    typeof conversation.complete === "boolean" &&
    Array.isArray(conversation.messages) &&
    conversation.messages.every(isConversationMessage)
  );
}

/**
 * 一覧の要求 URL。`cursor` はサーバーが発行した `nextCursor` をそのまま渡す。
 * 自作しない（符号の形は API 側の実装詳細）。
 */
export function listConversationsUrl(cursor?: string): string {
  if (cursor === undefined) return CONVERSATIONS_PATH;
  return `${CONVERSATIONS_PATH}?cursor=${encodeURIComponent(cursor)}`;
}

/**
 * 履歴の一覧（メタデータのみ）を1ページ取る。
 * `cursor` に前回応答の `nextCursor` を渡すと続きを読む。
 */
export async function fetchConversations(
  fetcher: typeof fetch,
  sessionRetries: number,
  cursor?: string,
): Promise<ListConversationsResult> {
  const body = await requestJson<unknown>(listConversationsUrl(cursor), fetcher, sessionRetries);
  if (typeof body !== "object" || body === null) throw new ApiError("unavailable");
  const result = body as { conversations?: unknown; nextCursor?: unknown };
  if (
    !Array.isArray(result.conversations) ||
    !result.conversations.every(isConversationSummary) ||
    (result.nextCursor !== null && typeof result.nextCursor !== "string")
  ) {
    throw new ApiError("unavailable");
  }
  return {
    conversations: result.conversations,
    nextCursor: result.nextCursor as string | null,
  };
}

/** 1会話の本文込みの詳細を取る。404 は `not_found` として呼び出し側へ返す。 */
export async function fetchConversation(
  fetcher: typeof fetch,
  sessionRetries: number,
  id: string,
): Promise<Conversation> {
  const body = await requestJson<unknown>(
    `${CONVERSATIONS_PATH}/${encodeURIComponent(id)}`,
    fetcher,
    sessionRetries,
  );
  if (!isConversation(body)) throw new ApiError("unavailable");
  return body;
}

export interface ConversationExportResult {
  version: number;
  exportedAt: string;
  conversations: Conversation[];
}

/**
 * 全履歴のエクスポートを取る。利用者が手元へ保管するものなので version は
 * 現在値に縛らず数値であることだけを見る（learning-data と同じ判断）。
 */
export async function fetchConversationsExport(
  fetcher: typeof fetch,
  sessionRetries: number,
): Promise<ConversationExportResult> {
  const body = await requestJson<unknown>(CONVERSATIONS_EXPORT_PATH, fetcher, sessionRetries);
  if (typeof body !== "object" || body === null) throw new ApiError("unavailable");
  const result = body as Record<string, unknown>;
  if (
    typeof result.version !== "number" ||
    typeof result.exportedAt !== "string" ||
    !Array.isArray(result.conversations) ||
    !result.conversations.every(isConversation)
  ) {
    throw new ApiError("unavailable");
  }
  return body as ConversationExportResult;
}

function toDeletedCount(value: unknown): number {
  if (typeof value !== "object" || value === null) throw new ApiError("unavailable");
  const count = (value as { deletedCount?: unknown }).deletedCount;
  if (typeof count !== "number") throw new ApiError("unavailable");
  return count;
}

/** 履歴を1件削除する。冪等なので失敗時は再実行してよい。 */
export async function deleteConversation(fetcher: typeof fetch, id: string): Promise<number> {
  const body = await deleteJson<unknown>(
    `${CONVERSATIONS_PATH}/${encodeURIComponent(id)}`,
    fetcher,
  );
  return toDeletedCount(body);
}

/** 履歴を全件削除する。オプトインを切ったあとの掃除用。 */
export async function deleteAllConversations(fetcher: typeof fetch): Promise<number> {
  const body = await deleteJson<unknown>(CONVERSATIONS_PATH, fetcher);
  return toDeletedCount(body);
}

/**
 * 保存元の表示名。`origin` はクライアント採番の文字列なので、
 * 知らない値はそのまま出す（隠すと「どこから保存されたか」が追えない）。
 */
export function originLabel(origin: string): string {
  switch (origin) {
    case "desktop":
      return "デスクトップ";
    case "vscode":
      return "VS Code";
    case "web":
      return "Web";
    case "cli":
      return "CLI";
    default:
      return origin;
  }
}

/** ダウンロード用のファイル名。日付は UTC で切る。 */
export function exportConversationsFileName(now: Date): string {
  return `gakushu-sochi-conversations-${now.toISOString().slice(0, 10)}.json`;
}
