/**
 * 会話履歴のアップロードとオプトインの切り替え（Issue #204）。
 *
 * 設計の正本は docs/conversation-history.md。learning/sync.ts と同じく
 * 例外を投げず、失敗は理由付きの `ok: false` で返す。
 * 履歴の保存失敗が質問フローを止めてはならないためである。
 */

import type { Conversation } from "@gakushu-sochi/domain";

import { isSafeApiBaseUrl } from "../learning/sync";

/** 会話系 API の呼び出しに必要な設定。 */
export interface ConversationSyncConfig {
  apiBaseUrl: string;
  apiToken: () => Promise<string>;
}

/** 単発の外向きリクエストの上限（learning/sync.ts と同じ値）。 */
const TIMEOUT_MS = 10_000;

export type ConversationSyncOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      /**
       * 403（サーバー側でオプトインが無効）なら true。
       * ローカルキャッシュが古い確定情報なので、呼び出し側はキャッシュを落とす。
       */
      disabled?: boolean;
    };

/** `PUT /v1/conversations/:id` で会話を1件保存する。 */
export async function uploadConversation(
  conversation: Conversation,
  config: ConversationSyncConfig,
): Promise<ConversationSyncOutcome> {
  if (!isSafeApiBaseUrl(config.apiBaseUrl)) {
    // トークンを載せる前に弾く（learning/sync.ts と同じ理屈）。
    return {
      ok: false,
      reason: `APIのURLが安全ではありません（https、またはローカル開発のみ許可）: ${config.apiBaseUrl}`,
    };
  }

  const url = `${config.apiBaseUrl.replace(/\/+$/, "")}/v1/conversations/${encodeURIComponent(conversation.id)}`;

  try {
    const apiToken = await config.apiToken();
    if (!apiToken) return { ok: false, reason: "再ログインが必要です" };
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(conversation),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      if (response.status === 401) return { ok: false, reason: "再ログインが必要です" };
      if (response.status === 403) {
        return {
          ok: false,
          reason: "サーバー側で質問履歴の保存が無効です",
          disabled: true,
        };
      }
      return { ok: false, reason: `HTTP ${response.status}` };
    }
    // 200 でも保存結果を本文で確かめる。{ saved: false }（新しい会話が既存）
    // や形の違う応答を「保存できた」と見なすと、履歴が黙って抜ける（RULE-004）。
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || (body as { saved?: unknown }).saved !== true) {
      const reason = (body as { reason?: unknown } | null)?.reason;
      return {
        ok: false,
        reason:
          reason === "newer_exists"
            ? "同じIDの新しい質問履歴が既にサーバーにあります"
            : "サーバー応答の形式が不正です",
      };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.message === "再ログインが必要です") {
      return { ok: false, reason: "再ログインが必要です" };
    }
    return { ok: false, reason: `ネットワークエラー: ${String(error)}` };
  }
}

/** `GET /v1/user-settings` の応答のうち、ここで必要な項目。 */
interface RemoteUserSettingsBody {
  displayName: string | null;
  activityPeriodDays: number;
  saveConversationHistory: boolean;
}

function isRemoteUserSettingsBody(value: unknown): value is RemoteUserSettingsBody {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as Record<string, unknown>;
  return (
    (settings.displayName === null || typeof settings.displayName === "string") &&
    typeof settings.activityPeriodDays === "number" &&
    typeof settings.saveConversationHistory === "boolean"
  );
}

async function requestUserSettings(
  config: ConversationSyncConfig,
  init: { method: "GET" } | { method: "PUT"; body: unknown },
): Promise<{ ok: true; settings: RemoteUserSettingsBody } | { ok: false; reason: string }> {
  if (!isSafeApiBaseUrl(config.apiBaseUrl)) {
    return {
      ok: false,
      reason: `APIのURLが安全ではありません（https、またはローカル開発のみ許可）: ${config.apiBaseUrl}`,
    };
  }
  const url = `${config.apiBaseUrl.replace(/\/+$/, "")}/v1/user-settings`;
  try {
    const apiToken = await config.apiToken();
    if (!apiToken) return { ok: false, reason: "再ログインが必要です" };
    const response = await fetch(url, {
      method: init.method,
      headers: {
        ...(init.method === "PUT" ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${apiToken}`,
      },
      ...(init.method === "PUT" ? { body: JSON.stringify(init.body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.status === 401) return { ok: false, reason: "再ログインが必要です" };
      return { ok: false, reason: `HTTP ${response.status}` };
    }
    const body: unknown = await response.json();
    if (!isRemoteUserSettingsBody(body)) {
      // 形が違う応答を既定値へ黙って落とさない。古いサーバーでは
      // saveConversationHistory が存在しないため、未対応として扱う（RULE-004）。
      return {
        ok: false,
        reason:
          "サーバー応答の形式が不正です（このサーバーは質問履歴の保存に未対応の可能性があります）",
      };
    }
    return { ok: true, settings: body };
  } catch (error) {
    if (error instanceof Error && error.message === "再ログインが必要です") {
      return { ok: false, reason: "再ログインが必要です" };
    }
    return { ok: false, reason: `ネットワークエラー: ${String(error)}` };
  }
}

export type UpdateOptInOutcome = { ok: true; enabled: boolean } | { ok: false; reason: string };

/**
 * サーバー側の `saveConversationHistory` を読む。
 * 切り替えコマンドが現在値を表示するために使う。オフラインでは読めない。
 */
export async function getRemoteSaveConversationHistory(
  config: ConversationSyncConfig,
): Promise<UpdateOptInOutcome> {
  const current = await requestUserSettings(config, { method: "GET" });
  if (!current.ok) return { ok: false, reason: current.reason };
  return { ok: true, enabled: current.settings.saveConversationHistory };
}

/**
 * `saveConversationHistory` だけを切り替える。
 *
 * PUT は省略項目を現状維持するため、切り替えたい項目だけを送る。
 * 読んでから全項目を送り返すと、読み取りと書き込みの間に別端末が
 * 変更した項目（表示名など）を古い値で上書きしてしまう。
 */
export async function setRemoteSaveConversationHistory(
  enabled: boolean,
  config: ConversationSyncConfig,
): Promise<UpdateOptInOutcome> {
  const saved = await requestUserSettings(config, {
    method: "PUT",
    body: { saveConversationHistory: enabled },
  });
  if (!saved.ok) return { ok: false, reason: saved.reason };
  return { ok: true, enabled: saved.settings.saveConversationHistory };
}
