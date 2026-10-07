// 常駐トレイの生成とメニュー（Issue #279 ステップ 3 で index.ts から分離）。
import { app, Menu, nativeImage, Tray } from "electron";

import { appState } from "./app-state.js";
import { activatePopup } from "./activation.js";
import { openAccessibilitySettings } from "./accessibility.js";
import { openForSelection } from "./clipboard.js";
import { reviewConsent } from "./consent-dialog.js";
import { createPopup, showPopup } from "./windows/popup.js";

const SERVICE_NAME = "Gakushu Sochi";

export function createTray(): void {
  const tray = new Tray(nativeImage.createEmpty());
  appState.tray = tray;
  tray.setToolTip(SERVICE_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "選択テキストを質問",
        click: () => {
          void openForSelection();
        },
      },
      { label: "設定", click: () => showPopup("") },
      {
        label: "送信内容の同意",
        click: () => {
          // showPopup("") は表示中の選択テキストを消してしまうため、
          // ウィンドウを出すだけにして文面はダイアログで見せる。
          appState.popup ??= createPopup();
          activatePopup(app, appState.popup);
          void reviewConsent();
        },
      },
      ...(process.platform === "darwin"
        ? [
            {
              label: "アクセシビリティ設定を開く",
              click: () => {
                void openAccessibilitySettings().catch((error) =>
                  showPopup(
                    "",
                    error instanceof Error
                      ? `アクセシビリティ設定を開けませんでした: ${error.message}`
                      : "アクセシビリティ設定を開けませんでした。",
                  ),
                );
              },
            },
          ]
        : []),
      { type: "separator" },
      { label: "終了", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => {
    void openForSelection();
  });
}
