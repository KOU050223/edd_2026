// Gakushu Sochi Desktop のエントリポイント。
// 処理の本体は各機能モジュールへ置き、ここは単一インスタンスの制御と
// 起動順序の配線だけにする（Issue #279 ステップ 3）。
import { app, dialog, globalShortcut } from "electron";

import { guideAccessibilityPermission } from "./accessibility.js";
import { appState } from "./app-state.js";
import { registerAnswerIpc } from "./ipc/answer.js";
import { registerAuthIpc } from "./ipc/auth.js";
import { registerConsentIpc } from "./ipc/consent.js";
import { registerConversationsIpc } from "./ipc/conversations.js";
import { registerHistoryIpc } from "./ipc/history.js";
import { registerSettingsIpc } from "./ipc/settings.js";
import { registerWindowIpc } from "./ipc/window.js";
import { loadSettings, updateLoginItem } from "./settings-store.js";
import { registerShortcut } from "./shortcut.js";
import { shouldShowStartupWindow } from "./startup.js";
import { createTray } from "./tray.js";
import { resolveRendererDevServerUrl, showPopup } from "./windows/popup.js";

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (appState.popup) {
    appState.popup.show();
    appState.popup.focus();
  }
});

app
  .whenReady()
  .then(async () => {
    if (!hasSingleInstanceLock) return;
    appState.rendererDevServerUrl = resolveRendererDevServerUrl();
    await loadSettings();
    updateLoginItem();
    await guideAccessibilityPermission();
    createTray();
    registerShortcut(appState.settings.shortcut);
    registerSettingsIpc();
    registerAuthIpc();
    registerAnswerIpc();
    registerConversationsIpc();
    registerConsentIpc();
    registerHistoryIpc();
    registerWindowIpc();
    if (shouldShowStartupWindow(app.isPackaged)) showPopup("");
  })
  .catch((error) => {
    console.error("アプリの初期化に失敗しました", error);
    const message = error instanceof Error ? error.message : "アプリの初期化に失敗しました。";
    dialog.showErrorBox("Gakushu Sochi の起動に失敗しました", message);
    app.quit();
  });

app.on("will-quit", () => globalShortcut.unregisterAll());
