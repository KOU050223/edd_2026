// settings.json の読み書きとログイン項目の反映（Issue #279 ステップ 3 で index.ts から分離）。
import { app } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { appState } from "./app-state.js";
import { normalizeSettings, type DesktopSettings } from "./settings.js";

export async function loadSettings(): Promise<void> {
  const settingsPath = path.join(app.getPath("userData"), "settings.json");
  try {
    appState.settings = normalizeSettings(JSON.parse(await readFile(settingsPath, "utf8")));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("設定ファイルを読み込めませんでした", { cause: error });
  }
}

export async function saveSettings(next: DesktopSettings): Promise<void> {
  const settingsPath = path.join(app.getPath("userData"), "settings.json");
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  appState.settings = next;
  updateLoginItem();
}

export function updateLoginItem(): void {
  // 開発中は electron バイナリ自身をログイン項目へ登録できないため、
  // パッケージ済みアプリでのみ OS の自動起動設定を変更する。
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: appState.settings.launchAtLogin });
  }
}
