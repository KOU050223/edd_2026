// conversation-history:* / conversations:* のハンドラ登録
// （Issue #279 ステップ 3 で index.ts から分離）。
import { dialog } from "electron";

import { CONVERSATION_HISTORY_OPT_IN_NOTICE } from "@gakushu-sochi/domain";

import { apiDeps } from "../api-deps.js";
import { appState } from "../app-state.js";
import {
  deleteConversation,
  getConversation,
  getUserSettings,
  listConversations,
  setSaveConversationHistory,
} from "../conversations-api.js";
import { saveSettings } from "../settings-store.js";
import { INVOKE_CHANNELS } from "../../shared/ipc.js";
import { handle } from "./helpers.js";

export function registerConversationsIpc(): void {
  // 「質問履歴の保存」オプトイン（Issue #204）。表示はサーバーの値を正とし、
  // 読めたらローカルキャッシュ（settings.json）も揃える。
  handle(INVOKE_CHANNELS.conversationHistoryGet, async () => {
    const remote = await getUserSettings(apiDeps());
    if (remote.saveConversationHistory !== appState.settings.saveConversationHistory) {
      // キャッシュの同期失敗で表示自体を止めない。読めた値は確実なので
      // そのまま返し、書き込みの失敗はログに残す。
      try {
        await saveSettings({
          ...appState.settings,
          saveConversationHistory: remote.saveConversationHistory,
        });
      } catch (cacheError) {
        console.error("質問履歴オプトインのローカルキャッシュを同期できませんでした", cacheError);
      }
    }
    return { saveConversationHistory: remote.saveConversationHistory };
  });
  handle(INVOKE_CHANNELS.conversationHistorySet, async (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") {
      throw new Error("質問履歴の保存は真偽値で指定してください。");
    }
    if (enabled) {
      // 有効化の前に、何が保存され・いつ消えるかを利用者へ明示する
      // （docs/data-privacy.md のオプトイン要件）。
      const options = {
        type: "info" as const,
        title: "質問履歴の保存",
        message: "質問履歴の保存を有効にしますか？",
        detail: CONVERSATION_HISTORY_OPT_IN_NOTICE,
        buttons: ["有効にする", "キャンセル"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      };
      const result = appState.popup
        ? await dialog.showMessageBox(appState.popup, options)
        : await dialog.showMessageBox(options);
      if (result.response !== 0) {
        // キャンセルは失敗ではない。現在値を返して画面を現状へ戻す。
        return { saveConversationHistory: appState.settings.saveConversationHistory };
      }
    }
    const saved = await setSaveConversationHistory(apiDeps(), enabled);
    if (saved.saveConversationHistory !== appState.settings.saveConversationHistory) {
      // サーバー側は保存済み。ローカルキャッシュの書き込みだけ失敗しても
      // オプトイン自体は有効なので、失敗はログに残して続ける。
      try {
        await saveSettings({
          ...appState.settings,
          saveConversationHistory: saved.saveConversationHistory,
        });
      } catch (cacheError) {
        console.error("質問履歴オプトインのローカルキャッシュを保存できませんでした", cacheError);
      }
    }
    return { saveConversationHistory: saved.saveConversationHistory };
  });
  // 質問履歴（Issue #199）。サイドバーの一覧と詳細表示に使う。
  // 値の正はサーバーで、本文はこの端末へ永続化しない。
  handle(INVOKE_CHANNELS.conversationsList, (_event, cursor: unknown) => {
    if (cursor !== undefined && typeof cursor !== "string") {
      throw new Error("カーソルは文字列で指定してください。");
    }
    return listConversations(apiDeps(), cursor);
  });
  handle(INVOKE_CHANNELS.conversationsGet, (_event, id: unknown) => {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("履歴の ID が指定されていません。");
    }
    return getConversation(apiDeps(), id);
  });
  handle(INVOKE_CHANNELS.conversationsDelete, (_event, id: unknown) => {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("削除する履歴の ID が指定されていません。");
    }
    return deleteConversation(apiDeps(), id);
  });
}
