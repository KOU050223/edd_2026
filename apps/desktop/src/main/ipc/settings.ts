// settings:* のハンドラ登録（Issue #279 ステップ 3 で index.ts から分離）。
import { appState } from "../app-state.js";
import { normalizeSettingsForSave } from "../settings.js";
import { saveSettings } from "../settings-store.js";
import { registerShortcut } from "../shortcut.js";
import { refreshTokenStore } from "../token-store.js";
import { INVOKE_CHANNELS, type DesktopSettings } from "../../shared/ipc.js";
import { handle } from "./helpers.js";

export function registerSettingsIpc(): void {
  handle(INVOKE_CHANNELS.settingsGet, async () => ({
    ...appState.settings,
    hasRefreshToken: Boolean(refreshTokenStore().get()),
  }));
  handle(INVOKE_CHANNELS.settingsSave, async (_event, next: DesktopSettings) => {
    const valid = normalizeSettingsForSave(next);
    try {
      registerShortcut(valid.shortcut);
    } catch (error) {
      registerShortcut(appState.settings.shortcut);
      throw error;
    }
    await saveSettings(valid);
  });
}
