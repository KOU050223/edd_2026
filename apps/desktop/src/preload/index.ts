import { contextBridge } from "electron";

import { EVENT_CHANNELS, INVOKE_CHANNELS, type DesktopApi } from "../shared/ipc.js";
import { invoke, on } from "./ipc.js";

// 契約は src/shared/ipc.ts が正本。メソッド名の抜け・対応するチャネルのずれは
// satisfies と型検査で落ちる。
const api = {
  getSettings: () => invoke(INVOKE_CHANNELS.settingsGet),
  saveSettings: (settings) => invoke(INVOKE_CHANNELS.settingsSave, settings),
  login: () => invoke(INVOKE_CHANNELS.authLogin),
  logout: () => invoke(INVOKE_CHANNELS.authLogout),
  retrySelection: () => invoke(INVOKE_CHANNELS.selectionRetry),
  ask: (selection, question) => invoke(INVOKE_CHANNELS.answerAsk, selection, question),
  cancelAnswer: () => invoke(INVOKE_CHANNELS.answerCancel),
  getConsentStatus: () => invoke(INVOKE_CHANNELS.consentStatus),
  reviewConsent: () => invoke(INVOKE_CHANNELS.consentReview),
  // 質問履歴の保存オプトイン（Issue #204）。値はサーバーの user-settings が正。
  getConversationHistoryOptIn: () => invoke(INVOKE_CHANNELS.conversationHistoryGet),
  setConversationHistoryOptIn: (enabled) => invoke(INVOKE_CHANNELS.conversationHistorySet, enabled),
  onHistorySaveFailed: (listener) => on(EVENT_CHANNELS.historySaveFailed, listener),
  close: () => invoke(INVOKE_CHANNELS.windowClose),
  minimize: () => invoke(INVOKE_CHANNELS.windowMinimize),
  openExternalLink: (url) => invoke(INVOKE_CHANNELS.externalLinkOpen, url),
  // 質問履歴の一覧・詳細・削除（Issue #199）。
  listConversations: (cursor) => invoke(INVOKE_CHANNELS.conversationsList, cursor),
  getConversation: (id) => invoke(INVOKE_CHANNELS.conversationsGet, id),
  deleteConversation: (id) => invoke(INVOKE_CHANNELS.conversationsDelete, id),
  openAccessibilitySettings: () => invoke(INVOKE_CHANNELS.systemAccessibility),
  onSelection: (listener) => on(EVENT_CHANNELS.selection, listener),
  onDelta: (listener) => on(EVENT_CHANNELS.answerDelta, listener),
  // 履歴インポート（Issue #157）
  historyDetect: () => invoke(INVOKE_CHANNELS.historyDetect),
  historyPickFile: () => invoke(INVOKE_CHANNELS.historyPickFile),
  historyAnalyze: (request) => invoke(INVOKE_CHANNELS.historyAnalyze, request),
  historyBuildPrompt: () => invoke(INVOKE_CHANNELS.historyBuildPrompt),
  historyPasteAnalysis: (text) => invoke(INVOKE_CHANNELS.historyPasteAnalysis, text),
  historyApply: (payload) => invoke(INVOKE_CHANNELS.historyApply, payload),
  historyList: () => invoke(INVOKE_CHANNELS.historyList),
  historyUndo: (id) => invoke(INVOKE_CHANNELS.historyUndo, id),
  historyDeleteProvider: (provider) => invoke(INVOKE_CHANNELS.historyDeleteProvider, provider),
  onHistoryProgress: (listener) => on(EVENT_CHANNELS.historyProgress, listener),
  onAuthState: (listener) => on(EVENT_CHANNELS.authState, listener),
} satisfies DesktopApi;

contextBridge.exposeInMainWorld("desktop", api);
