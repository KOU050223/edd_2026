// グローバルショートカットの登録（Issue #279 ステップ 3 で index.ts から分離）。
import { globalShortcut } from "electron";

import { openForSelection } from "./clipboard.js";

export function registerShortcut(shortcut: string): void {
  globalShortcut.unregisterAll();
  if (
    !globalShortcut.register(shortcut, () => {
      void openForSelection();
    })
  ) {
    throw new Error(
      `ショートカット「${shortcut}」を登録できませんでした。他のアプリとの競合または権限を確認してください。`,
    );
  }
}
