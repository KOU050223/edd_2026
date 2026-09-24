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
  close: () => ipcRenderer.invoke("window:close"),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  openExternalLink: (url: string) => ipcRenderer.invoke("external-link:open", url),
  getConcepts: () => ipcRenderer.invoke("concepts:list"),
  openAccessibilitySettings: () => ipcRenderer.invoke("system:accessibility"),
  onSelection: (listener: (payload: { selection: string; error?: string }) => void) =>
    ipcRenderer.on("selection", (_event, payload) => listener(payload)),
  onDelta: (listener: (delta: string) => void) =>
    ipcRenderer.on("answer:delta", (_event, delta) => listener(delta)),
  onAuthState: (listener: (payload: { hasRefreshToken: boolean }) => void) =>
    ipcRenderer.on("auth:state", (_event, payload) => listener(payload)),
});
