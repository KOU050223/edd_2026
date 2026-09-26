import type { Conversation } from "@gakushu-sochi/domain";

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
 * オプトインだけを切り替える。`displayName` や `activityPeriodDays` は
 * PUT が必須項目とするため、先に GET で読んだ現在値をそのまま送り返す。
 * 省略して送ると「切り替えたつもりが他項目まで消えた」になる。
 */
export async function setSaveConversationHistory(
  deps: AuthedApiDeps,
  enabled: boolean,
): Promise<RemoteUserSettings> {
  const current = await getUserSettings(deps);
  const parsed = await authedApiRequest<unknown>(deps, "/user-settings", {
    method: "PUT",
    body: {
      displayName: current.displayName,
      activityPeriodDays: current.activityPeriodDays,
      saveConversationHistory: enabled,
    },
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
