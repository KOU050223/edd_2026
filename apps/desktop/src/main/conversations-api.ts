import { CONVERSATION_ORIGINS, type Conversation } from "@gakushu-sochi/domain";

import { ApiRequestError, authedApiRequest, type AuthedApiDeps } from "./api-request.js";

/**
 * 会話履歴とユーザー設定の API クライアント（Issue #204）。
 *
 * 契約の正本は `apps/api/src/contract/conversations.ts` と
 * `contract/user-settings.ts`。ここで再定義せず、応答の形だけを検証する。
 */

/** `GET /v1/user-settings` の応答のうち、ここで必要な項目。 */
export interface RemoteUserSettings {
  displayName: string | null;
  activityPeriodDays: number;
  saveConversationHistory: boolean;
}

function isRemoteUserSettings(value: unknown): value is RemoteUserSettings {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as Record<string, unknown>;
  return (
    (settings.displayName === null || typeof settings.displayName === "string") &&
    typeof settings.activityPeriodDays === "number" &&
    typeof settings.saveConversationHistory === "boolean"
  );
}

export async function getUserSettings(deps: AuthedApiDeps): Promise<RemoteUserSettings> {
  const parsed = await authedApiRequest<unknown>(deps, "/user-settings", { method: "GET" });
  if (!isRemoteUserSettings(parsed)) {
    throw new ApiRequestError(200, "ユーザー設定の応答の形が不正です。");
  }
  return parsed;
}

/**
 * オプトインだけを切り替える。PUT は省略項目を現状維持するため、
 * 切り替えたい項目だけを送る。読んでから全項目を送り返すと、
 * 読み取りと書き込みの間に別端末が変更した項目を古い値で上書きする。
 */
export async function setSaveConversationHistory(
  deps: AuthedApiDeps,
  enabled: boolean,
): Promise<RemoteUserSettings> {
  const parsed = await authedApiRequest<unknown>(deps, "/user-settings", {
    method: "PUT",
    body: { saveConversationHistory: enabled },
  });
  if (!isRemoteUserSettings(parsed)) {
    throw new ApiRequestError(200, "ユーザー設定の応答の形が不正です。");
  }
  return parsed;
}

/**
 * 会話を upsert する。`saved: false`（newer_exists）は同じ ID により新しい
 * 会話が既にあることを意味し、Desktop は毎回新しい UUID を採番するため
 * 通常は起きない。起きた場合も応答としては正常なので例外にしない。
 */
export function putConversation(
  deps: AuthedApiDeps,
  conversation: Conversation,
): Promise<{ saved: boolean; reason?: "newer_exists" }> {
  return authedApiRequest(deps, `/conversations/${encodeURIComponent(conversation.id)}`, {
    method: "PUT",
    body: conversation,
  });
}

// ---------------------------------------------------------------------------
// 履歴の読み取り（Issue #199）。サイドバーの一覧と詳細表示に使う。
// ---------------------------------------------------------------------------

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
    (summary.clientId === undefined || typeof summary.clientId === "string") &&
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

function isConversation(value: unknown): value is Conversation {
  if (typeof value !== "object" || value === null) return false;
  const conversation = value as Record<string, unknown>;
  return (
    typeof conversation.id === "string" &&
    CONVERSATION_ORIGINS.includes(conversation.origin as (typeof CONVERSATION_ORIGINS)[number]) &&
    (conversation.clientId === undefined || typeof conversation.clientId === "string") &&
    (conversation.title === undefined || typeof conversation.title === "string") &&
    (conversation.language === undefined || typeof conversation.language === "string") &&
    (conversation.fileName === undefined || typeof conversation.fileName === "string") &&
    typeof conversation.occurredAt === "string" &&
    typeof conversation.updatedAt === "string" &&
    typeof conversation.complete === "boolean" &&
    Array.isArray(conversation.messages) &&
    conversation.messages.every(isConversationMessage)
  );
}

/**
 * 履歴の一覧（メタデータのみ）を1ページ取る。
 * `cursor` には前回応答の `nextCursor` をそのまま渡す。自作しない
 * （符号の形は API 側の実装詳細）。
 */
export async function listConversations(
  deps: AuthedApiDeps,
  cursor?: string,
): Promise<ListConversationsResult> {
  const path =
    cursor === undefined ? "/conversations" : `/conversations?cursor=${encodeURIComponent(cursor)}`;
  const parsed = await authedApiRequest<unknown>(deps, path, { method: "GET" });
  if (typeof parsed !== "object" || parsed === null) {
    throw new ApiRequestError(200, "質問履歴の応答の形が不正です。");
  }
  const result = parsed as { conversations?: unknown; nextCursor?: unknown };
  if (
    !Array.isArray(result.conversations) ||
    !result.conversations.every(isConversationSummary) ||
    (result.nextCursor !== null && typeof result.nextCursor !== "string")
  ) {
    throw new ApiRequestError(200, "質問履歴の応答の形が不正です。");
  }
  return { conversations: result.conversations, nextCursor: result.nextCursor };
}

/** 1会話の本文込みの詳細を取る。404 は ApiRequestError として呼び出し側へ返す。 */
export async function getConversation(deps: AuthedApiDeps, id: string): Promise<Conversation> {
  const parsed = await authedApiRequest<unknown>(deps, `/conversations/${encodeURIComponent(id)}`, {
    method: "GET",
  });
  if (!isConversation(parsed)) {
    throw new ApiRequestError(200, "質問履歴の応答の形が不正です。");
  }
  return parsed;
}

/** 履歴を1件削除する。冪等なので失敗時は再実行してよい。 */
export async function deleteConversation(
  deps: AuthedApiDeps,
  id: string,
): Promise<{ deletedCount: number }> {
  const parsed = await authedApiRequest<unknown>(deps, `/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { deletedCount?: unknown }).deletedCount !== "number"
  ) {
    throw new ApiRequestError(200, "削除の応答の形が不正です。");
  }
  return parsed as { deletedCount: number };
}
