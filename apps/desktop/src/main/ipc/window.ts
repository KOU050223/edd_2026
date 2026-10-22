// window:* / external-link:* / system:* のハンドラ登録
// （Issue #279 ステップ 3 で index.ts から分離）。
import { shell } from "electron";

import { openAccessibilitySettings } from "../accessibility.js";
import { appState } from "../app-state.js";
import { isSafeExternalUrl } from "../external-link.js";
import { INVOKE_CHANNELS } from "../../shared/ipc.js";
import { handle } from "./helpers.js";
import { INVOKE_SCHEMAS } from "./schemas.js";

export function registerWindowIpc(): void {
  handle(INVOKE_CHANNELS.windowClose, INVOKE_SCHEMAS["window:close"], () => appState.popup?.hide());
  handle(INVOKE_CHANNELS.windowMinimize, INVOKE_SCHEMAS["window:minimize"], () =>
    appState.popup?.minimize(),
  );
  handle(
    INVOKE_CHANNELS.externalLinkOpen,
    INVOKE_SCHEMAS["external-link:open"],
    async (_e, url) => {
      if (!isSafeExternalUrl(url)) {
        throw new Error("このリンクは開けません。");
      }
      await shell.openExternal(url);
    },
  );
  handle(INVOKE_CHANNELS.systemAccessibility, INVOKE_SCHEMAS["system:accessibility"], async () => {
    await openAccessibilitySettings();
  });
}
