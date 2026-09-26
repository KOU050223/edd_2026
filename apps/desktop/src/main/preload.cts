import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: unknown) => ipcRenderer.invoke("settings:save", settings),
  login: () => ipcRenderer.invoke("auth:login"),
  logout: () => ipcRenderer.invoke("auth:logout"),
  retrySelection: () => ipcRenderer.invoke("selection:retry"),
  ask: (selection: string, question: string) =>
    ipcRenderer.invoke("answer:ask", selection, question),
  getConsentStatus: () => ipcRenderer.invoke("consent:status"),
  reviewConsent: () => ipcRenderer.invoke("consent:review"),
  // 質問履歴の保存オプトイン（Issue #204）。値はサーバーの user-settings が正。
  getConversationHistoryOptIn: () => ipcRenderer.invoke("conversation-history:get"),
  setConversationHistoryOptIn: (enabled: boolean) =>
    ipcRenderer.invoke("conversation-history:set", enabled),
  onHistorySaveFailed: (listener: (message: string) => void) =>
    ipcRenderer.on("history:save-failed", (_event, message) => listener(message)),
  close: () => ipcRenderer.invoke("window:close"),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  openExternalLink: (url: string) => ipcRenderer.invoke("external-link:open", url),
  getConcepts: () => ipcRenderer.invoke("concepts:list"),
  openAccessibilitySettings: () => ipcRenderer.invoke("system:accessibility"),
  onSelection: (listener: (payload: { selection: string; error?: string }) => void) =>
    ipcRenderer.on("selection", (_event, payload) => listener(payload)),
  onDelta: (listener: (delta: string) => void) =>
    ipcRenderer.on("answer:delta", (_event, delta) => listener(delta)),
  // 履歴インポート（Issue #157）
  historyDetect: () => ipcRenderer.invoke("history:detect"),
  historyPickFile: () => ipcRenderer.invoke("history:pick-file"),
  historyAnalyze: (request: unknown) => ipcRenderer.invoke("history:analyze", request),
  historyBuildPrompt: () => ipcRenderer.invoke("history:build-prompt"),
  historyPasteAnalysis: (text: string) => ipcRenderer.invoke("history:paste-analysis", text),
  historyApply: (payload: unknown) => ipcRenderer.invoke("history:apply", payload),
  historyList: () => ipcRenderer.invoke("history:list"),
  historyUndo: (id: string) => ipcRenderer.invoke("history:undo", id),
  historyDeleteProvider: (provider: string) =>
    ipcRenderer.invoke("history:delete-provider", provider),
  onHistoryProgress: (listener: (progress: unknown) => void) =>
    ipcRenderer.on("history:progress", (_event, progress) => listener(progress)),
  onAuthState: (listener: (payload: { hasRefreshToken: boolean }) => void) =>
    ipcRenderer.on("auth:state", (_event, payload) => listener(payload)),
});
