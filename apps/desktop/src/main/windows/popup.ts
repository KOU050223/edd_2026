// ポップアップウィンドウの生成と表示、開発時の dev server URL の検証
// （Issue #279 ステップ 3 で index.ts から分離）。
import { app, BrowserWindow, session, shell } from "electron";
import path from "node:path";

import { appState } from "../app-state.js";
import { activatePopup } from "../activation.js";
import { isSafeExternalUrl } from "../external-link.js";
import { RENDERER_INDEX_URL } from "../renderer-scheme.js";
import { send } from "../ipc/helpers.js";
import { EVENT_CHANNELS } from "../../shared/ipc.js";

// 開発時は renderer を Vite dev server（HMR）から読む。送信先は環境変数由来なので、
// loopback の http に限定する（RULE-003）。不正な値は起動を失敗させ、
// 黙って loadFile へフォールバックしない。
export function resolveRendererDevServerUrl(): string | undefined {
  if (app.isPackaged) return undefined;
  const raw = process.env.ELECTRON_RENDERER_URL;
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`ELECTRON_RENDERER_URL を URL として解釈できません: ${raw}`);
  }
  const isLoopbackHttp =
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!isLoopbackHttp) {
    throw new Error(
      `ELECTRON_RENDERER_URL は http://localhost / 127.0.0.1 / [::1] に限定してください: ${raw}`,
    );
  }
  return url.toString();
}

/**
 * セッション全体の Web 権限を拒否し、webView の取り付けを止める（Issue #279 ステップ 5）。
 * このアプリはカメラ・マイク・通知・webView を使わないので、要求が来た時点で拒否する。
 * 新しいウィンドウについては各 window の setWindowOpenHandler と同じ方針
 * （安全な外部リンクだけ shell で開き、ウィンドウは作らない）に揃える。
 */
export function installSessionSecurity(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (attachEvent) => {
      attachEvent.preventDefault();
    });
  });
}

export function createPopup(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    show: false,
    resizable: true,
    minimizable: true,
    // タイトルバーは renderer 側で描く。macOS は信号機を OS に出させたまま
    // 位置だけ寄せ、Windows / Linux は完全にフレームレスにする。
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 22 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(app.getAppPath(), "out/preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // preload は contextBridge・ipcRenderer だけを使うので sandbox 化できる。
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url).catch((error) => {
        console.error("外部リンクを開けませんでした", error);
      });
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url).catch((error) => {
        console.error("外部リンクを開けませんでした", error);
      });
    }
  });
  if (appState.rendererDevServerUrl) {
    void window.loadURL(appState.rendererDevServerUrl);
  } else {
    // 本番は app://renderer/ から配る（file:// は GrantFileProtocolExtraPrivileges を
    // 有効にしないと asar 内を読めず、有効にすると file:// ページにローカル
    // ファイルへの fetch 権まで付いてしまうため）。
    void window.loadURL(RENDERER_INDEX_URL);
  }
  window.on("closed", () => {
    appState.popup = undefined;
  });
  return window;
}

export function showPopup(selection: string, error?: string): void {
  appState.popup ??= createPopup();
  activatePopup(app, appState.popup);
  const sendSelection = () =>
    send(appState.popup?.webContents, EVENT_CHANNELS.selection, {
      selection,
      ...(error === undefined ? {} : { error }),
    });
  if (appState.popup.webContents.isLoading())
    appState.popup.webContents.once("did-finish-load", sendSelection);
  else sendSelection();
}
