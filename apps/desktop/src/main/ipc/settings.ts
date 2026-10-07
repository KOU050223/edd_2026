// settings:* のハンドラ登録（Issue #279 ステップ 3 で index.ts から分離）。
import { appState } from "../app-state.js";
import { saveSettings } from "../settings-store.js";
import { registerShortcut } from "../shortcut.js";
import { refreshTokenStore } from "../token-store.js";
import { INVOKE_CHANNELS } from "../../shared/ipc.js";
import { handle } from "./helpers.js";
import { INVOKE_SCHEMAS } from "./schemas.js";

export function registerSettingsIpc(): void {
  handle(INVOKE_CHANNELS.settingsGet, INVOKE_SCHEMAS["settings:get"], async () => ({
    ...appState.settings,
    hasRefreshToken: Boolean(refreshTokenStore().get()),
  }));
  // settings:save は厳密なスキーマで検証済み。ここで再度正規化すると、
  // 不正な項目が黙って既定値へ直されてしまう（RULE-004）ため直さない。
  handle(INVOKE_CHANNELS.settingsSave, INVOKE_SCHEMAS["settings:save"], async (_event, next) => {
    try {
      registerShortcut(next.shortcut);
    } catch (error) {
      registerShortcut(appState.settings.shortcut);
      throw error;
    }
    await saveSettings(next);
  });
}
