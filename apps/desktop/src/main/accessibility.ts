// アクセシビリティ許可の案内と設定画面を開く処理（Issue #279 ステップ 3 で index.ts から分離）。
import { dialog, systemPreferences } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

export async function guideAccessibilityPermission(): Promise<void> {
  if (process.platform !== "darwin" || systemPreferences.isTrustedAccessibilityClient(true)) return;
  const result = await dialog.showMessageBox({
    type: "warning",
    title: "アクセシビリティ許可が必要です",
    message: "選択テキストを取得するには、Gakushu Sochi にコンピュータの制御を許可してください。",
    detail:
      "システム設定の「プライバシーとセキュリティ > アクセシビリティ」で、開発中は Electron を追加して有効にしてください。許可後にアプリを再起動するとショートカットが使えます。",
    buttons: ["アクセシビリティ設定を開く", "後で設定する"],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response === 0) {
    await openAccessibilitySettings();
  }
}

export async function openAccessibilitySettings(): Promise<void> {
  if (process.platform !== "darwin") return;
  // URL スキームだけでは無視される macOS 環境があるため、アプリを明示する。
  await execFileAsync("/usr/bin/open", ["-a", "System Settings", ACCESSIBILITY_SETTINGS_URL]);
}
