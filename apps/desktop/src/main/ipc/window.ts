// window:* / external-link:* / system:* のハンドラ登録
// （Issue #279 ステップ 3 で index.ts から分離）。
import { shell } from "electron";

import { openAccessibilitySettings } from "../accessibility.js";
import { appState } from "../app-state.js";
import { isSafeExternalUrl } from "../external-link.js";
import { INVOKE_CHANNELS } from "../../shared/ipc.js";
import { handle } from "./helpers.js";

export function registerWindowIpc(): void {
  handle(INVOKE_CHANNELS.windowClose, () => appState.popup?.hide());
  handle(INVOKE_CHANNELS.windowMinimize, () => appState.popup?.minimize());
  handle(INVOKE_CHANNELS.externalLinkOpen, async (_event, url: unknown) => {
    if (typeof url !== "string" || !isSafeExternalUrl(url)) {
      throw new Error("このリンクは開けません。");
    }
    await shell.openExternal(url);
  });
  handle(INVOKE_CHANNELS.systemAccessibility, async () => {
    await openAccessibilitySettings();
  });
}
