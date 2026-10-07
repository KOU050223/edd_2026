// IPC の契約（Issue #279 ステップ 2）。main・preload・renderer の 3 者が
// 共有する唯一の正本。チャネル名・引数・戻り値・イベント payload をここだけで定義する。
//
// **このファイルは electron も Node も import しない**（renderer のバンドルからも
// 読むため）。型とチャネル名の定数だけを置く。DTO の型は `types.ts` が正本。
import type { Conversation, HistoryProviderId } from "@gakushu-sochi/domain";

import type {
  AuthState,
  ConsentStatus,
  ConversationHistoryOptIn,
  CreateImportSessionResult,
  DesktopSettings,
  HistoryAnalyzeRequest,
  HistoryApplyRequest,
  HistoryDetectResult,
  ImportAnalyzeView,
  ImportProgress,
  ImportSessionView,
  ListConversationsResult,
  SelectionEvent,
  SettingsState,
} from "./types.js";

export type {
  AuthState,
  ConsentStatus,
  ConversationHistoryOptIn,
  CreateImportSessionResult,
  DesktopSettings,
  HistoryAnalyzeRequest,
  HistoryApplyRequest,
  HistoryDetectResult,
  ImportAnalyzeView,
  ImportPreview,
  ImportPreviewView,
  ImportProgress,
  ImportSessionView,
  ListConversationsResult,
  SelectionEvent,
  SettingsState,
} from "./types.js";

// ---------------------------------------------------------------------------
// チャネル名（呼び出し側・受け側はリテラルを書かずこの定数を使う）
// ---------------------------------------------------------------------------

export const INVOKE_CHANNELS = {
  settingsGet: "settings:get",
  settingsSave: "settings:save",
  authLogin: "auth:login",
  authLogout: "auth:logout",
  selectionRetry: "selection:retry",
  answerAsk: "answer:ask",
  conversationHistoryGet: "conversation-history:get",
  conversationHistorySet: "conversation-history:set",
  consentStatus: "consent:status",
  consentReview: "consent:review",
  conversationsList: "conversations:list",
  conversationsGet: "conversations:get",
  conversationsDelete: "conversations:delete",
  historyDetect: "history:detect",
  historyPickFile: "history:pick-file",
  historyAnalyze: "history:analyze",
  historyBuildPrompt: "history:build-prompt",
  historyPasteAnalysis: "history:paste-analysis",
  historyApply: "history:apply",
  historyList: "history:list",
  historyUndo: "history:undo",
  historyDeleteProvider: "history:delete-provider",
  windowClose: "window:close",
  windowMinimize: "window:minimize",
  externalLinkOpen: "external-link:open",
  systemAccessibility: "system:accessibility",
} as const;

export const EVENT_CHANNELS = {
  selection: "selection",
  answerDelta: "answer:delta",
  authState: "auth:state",
  historySaveFailed: "history:save-failed",
  historyProgress: "history:progress",
} as const;

// ---------------------------------------------------------------------------
// invoke 系（renderer → main）の引数・戻り値
// ---------------------------------------------------------------------------

export interface InvokeContract {
  "settings:get": { args: []; result: SettingsState };
  "settings:save": { args: [settings: DesktopSettings]; result: void };
  "auth:login": { args: []; result: void };
  "auth:logout": { args: []; result: void };
  "selection:retry": { args: []; result: void };
  "answer:ask": { args: [selection: string, question: string]; result: void };
  "conversation-history:get": { args: []; result: ConversationHistoryOptIn };
  "conversation-history:set": {
    args: [enabled: boolean];
    result: ConversationHistoryOptIn;
  };
  "consent:status": { args: []; result: ConsentStatus };
  "consent:review": { args: []; result: ConsentStatus };
  // structured clone は省略引数と明示的な undefined を区別しないため、
  // 省略可能な引数は `| undefined` を型に含める（exactOptionalPropertyTypes）。
  "conversations:list": {
    args: [cursor?: string | undefined];
    result: ListConversationsResult;
  };
  "conversations:get": { args: [id: string]; result: Conversation };
  "conversations:delete": { args: [id: string]; result: { deletedCount: number } };
  "history:detect": { args: []; result: HistoryDetectResult };
  "history:pick-file": { args: []; result: string | null };
  "history:analyze": { args: [request: HistoryAnalyzeRequest]; result: ImportAnalyzeView };
  "history:build-prompt": { args: []; result: string };
  "history:paste-analysis": { args: [text: string]; result: ImportAnalyzeView };
  "history:apply": {
    args: [payload?: HistoryApplyRequest | undefined];
    result: CreateImportSessionResult;
  };
  "history:list": { args: []; result: { sessions: ImportSessionView[] } };
  "history:undo": {
    args: [id: string];
    result: { id: string; status: "undone"; deletedEvidenceCount: number };
  };
  "history:delete-provider": {
    args: [provider: HistoryProviderId];
    result: { deletedCount: number; sessionsMarkedUndone: number };
  };
  "window:close": { args: []; result: void };
  "window:minimize": { args: []; result: void };
  "external-link:open": { args: [url: string]; result: void };
  "system:accessibility": { args: []; result: void };
}

export type InvokeChannel = keyof InvokeContract;

// ---------------------------------------------------------------------------
// イベント系（main → renderer）の payload
// ---------------------------------------------------------------------------

export interface EventContract {
  selection: SelectionEvent;
  "answer:delta": string;
  "auth:state": AuthState;
  "history:save-failed": string;
  "history:progress": ImportProgress;
}

export type EventChannel = keyof EventContract;

// ---------------------------------------------------------------------------
// renderer へ公開する window.desktop の形
// ---------------------------------------------------------------------------

export interface DesktopApi {
  getSettings(): Promise<SettingsState>;
  saveSettings(settings: DesktopSettings): Promise<void>;
  login(): Promise<void>;
  logout(): Promise<void>;
  retrySelection(): Promise<void>;
  ask(selection: string, question: string): Promise<void>;
  getConsentStatus(): Promise<ConsentStatus>;
  reviewConsent(): Promise<ConsentStatus>;
  getConversationHistoryOptIn(): Promise<ConversationHistoryOptIn>;
  setConversationHistoryOptIn(enabled: boolean): Promise<ConversationHistoryOptIn>;
  onHistorySaveFailed(listener: (message: string) => void): () => void;
  close(): Promise<void>;
  minimize(): Promise<void>;
  openExternalLink(url: string): Promise<void>;
  listConversations(cursor?: string): Promise<ListConversationsResult>;
  getConversation(id: string): Promise<Conversation>;
  deleteConversation(id: string): Promise<{ deletedCount: number }>;
  openAccessibilitySettings(): Promise<void>;
  onSelection(listener: (payload: SelectionEvent) => void): () => void;
  onDelta(listener: (delta: string) => void): () => void;
  historyDetect(): Promise<HistoryDetectResult>;
  historyPickFile(): Promise<string | null>;
  historyAnalyze(request: HistoryAnalyzeRequest): Promise<ImportAnalyzeView>;
  historyBuildPrompt(): Promise<string>;
  historyPasteAnalysis(text: string): Promise<ImportAnalyzeView>;
  historyApply(payload?: HistoryApplyRequest): Promise<CreateImportSessionResult>;
  historyList(): Promise<{ sessions: ImportSessionView[] }>;
  historyUndo(id: string): Promise<{ id: string; status: "undone"; deletedEvidenceCount: number }>;
  historyDeleteProvider(
    provider: HistoryProviderId,
  ): Promise<{ deletedCount: number; sessionsMarkedUndone: number }>;
  onHistoryProgress(listener: (progress: ImportProgress) => void): () => void;
  onAuthState(listener: (payload: AuthState) => void): () => void;
}
