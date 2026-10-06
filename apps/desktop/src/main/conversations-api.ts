import { CONVERSATION_ORIGINS, type Conversation } from "@gakushu-sochi/domain";

import { ApiRequestError, authedApiRequest, type AuthedApiDeps } from "./api-request.js";

/**
 * 会話履歴とユーザー設定の API クライアント（Issue #204）。
 *
 * 契約の正本は `apps/api/src/contract/conversations.ts` と
 * `contract/user-settings.ts`。ここで再定義せず、応答の形だけを検証する。
 */

// ---------------------------------------------------------------------------
// 応答の形を検査するための小さな部品。フィールドごとの検査を表にして
// hasShape で型ガードにする（&& の羅列より項目と検査の対応が追いやすい）。
// ---------------------------------------------------------------------------

type FieldCheck = (value: unknown) => boolean;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString: FieldCheck = (value) => typeof value === "string";
const isNumber: FieldCheck = (value) => typeof value === "number";
const isBoolean: FieldCheck = (value) => typeof value === "boolean";

/** 省略可能な項目。キーが無い場合も undefined として渡される。 */
const optional =
  (check: FieldCheck): FieldCheck =>
  (value) =>
    value === undefined || check(value);

/** null を取りうる項目。 */
const nullable =
  (check: FieldCheck): FieldCheck =>
  (value) =>
    value === null || check(value);

/** 配列の全要素を検査する。 */
const arrayOf =
  (check: FieldCheck): FieldCheck =>
  (value) =>
    Array.isArray(value) && value.every(check);

/** 文字列の列挙値。 */
const oneOf =
  (values: readonly string[]): FieldCheck =>
  (value) =>
    values.includes(value as string);

/**
 * フィールドごとの検査表から型ガードを作る。表に無い余分なキーは
 * 許容する。サーバー側が先に項目を増やしても古いクライアントが
 * 応答を捨てないためである。
 */
function hasShape<T>(spec: { [K in keyof T]-?: FieldCheck }): (value: unknown) => value is T {
  const checks = Object.entries(spec) as [keyof T & string, FieldCheck][];
  return (value): value is T => {
    if (!isRecord(value)) return false;
    return checks.every(([key, check]) => check(value[key]));
  };
}

/** `GET /v1/user-settings` の応答のうち、ここで必要な項目。 */
export interface RemoteUserSettings {
  displayName: string | null;
  activityPeriodDays: number;
  saveConversationHistory: boolean;
}

const isRemoteUserSettings = hasShape<RemoteUserSettings>({
  displayName: nullable(isString),
  activityPeriodDays: isNumber,
  saveConversationHistory: isBoolean,
});

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

const isConversationSummary = hasShape<ConversationSummary>({
  id: isString,
  origin: isString,
  clientId: optional(isString),
  title: optional(isString),
  language: optional(isString),
  fileName: optional(isString),
  occurredAt: isString,
  updatedAt: isString,
  messageCount: isNumber,
  complete: isBoolean,
});

const isConversationMessage = hasShape<Conversation["messages"][number]>({
  role: oneOf(MESSAGE_ROLES),
  text: isString,
  at: isString,
});

const isConversation = hasShape<Conversation>({
  id: isString,
  origin: oneOf(CONVERSATION_ORIGINS),
  clientId: optional(isString),
  title: optional(isString),
  language: optional(isString),
  fileName: optional(isString),
  occurredAt: isString,
  updatedAt: isString,
  complete: isBoolean,
  messages: arrayOf(isConversationMessage),
});

const isListConversationsResult = hasShape<ListConversationsResult>({
  conversations: arrayOf(isConversationSummary),
  nextCursor: nullable(isString),
});

const isDeleteResult = hasShape<{ deletedCount: number }>({ deletedCount: isNumber });

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
  if (!isListConversationsResult(parsed)) {
    throw new ApiRequestError(200, "質問履歴の応答の形が不正です。");
  }
  return parsed;
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
  if (!isDeleteResult(parsed)) {
    throw new ApiRequestError(200, "削除の応答の形が不正です。");
  }
  return parsed;
}
