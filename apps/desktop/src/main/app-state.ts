// main プロセス内で共有する可変状態を 1 か所に集める（Issue #279 ステップ 3）。
// 各機能モジュールはここから読み書きし、モジュールグローバルを散らさない。
import type { BrowserWindow, Tray } from "electron";

import { AuthOperationState } from "./auth-operation.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import type { DesktopSettings } from "../shared/types.js";

export const appState = {
  /** 読み込み済みの設定。loadSettings / saveSettings が更新する。 */
  settings: { ...DEFAULT_SETTINGS } as DesktopSettings,
  /** メインのポップアップウィンドウ。閉じられると undefined に戻る。 */
  popup: undefined as BrowserWindow | undefined,
  /** トレイアイコン。createTray が保持する。 */
  tray: undefined as Tray | undefined,
  /** 開発時だけ Vite dev server の URL が入る。whenReady で検証してから使う。 */
  rendererDevServerUrl: undefined as string | undefined,
  /** 認証処理の世代管理。古い非同期処理の結果を破棄するために使う。 */
  authOperation: new AuthOperationState(),
};
