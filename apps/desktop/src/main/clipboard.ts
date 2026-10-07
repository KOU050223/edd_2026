// クリップボードの読み取り・コピー操作・選択テキスト取得
// （Issue #279 ステップ 3 で index.ts から分離）。
import { clipboard, shell, systemPreferences } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { appState } from "./app-state.js";
import { showPopup } from "./windows/popup.js";
import {
  BOOKMARK_TYPE,
  captureSelection,
  isBookmark,
  toClipboardEntries,
  type ClipboardBookmarkLike,
  type ClipboardSnapshot,
} from "./selection.js";

const execFileAsync = promisify(execFile);
const MAX_SELECTION_LENGTH = 20_000;

async function readClipboardSnapshot(): Promise<ClipboardSnapshot> {
  const items = await clipboard.read();
  const fingerprints: string[] = [];
  for (const item of items) {
    const values: string[] = [];
    for (const type of [...item.types].sort()) {
      const value = await item.getType(type);
      // 復元側（toClipboardEntries）と同じ 3 分岐にする。ここで形式を取り違えると
      // 指紋が衝突し、捕捉中に変わったクリップボードを上書きしかねない。
      if (value instanceof Blob) {
        const bytes = Buffer.from(await value.arrayBuffer()).toString("base64");
        values.push(`${type}:blob:${value.type}:${bytes}`);
      } else if (type === BOOKMARK_TYPE && isBookmark(value)) {
        values.push(`${type}:bookmark:${JSON.stringify([value.title, value.url])}`);
      } else {
        // 復元できない形式。JSON 化できない値では undefined が返り、
        // 別内容どうしが同じ指紋になってしまうため String() で必ず文字列にする。
        values.push(`${type}:unreconstructable:${String(JSON.stringify(value))}`);
      }
    }
    fingerprints.push(values.join("\u0000"));
  }
  return { items, fingerprint: fingerprints.join("\u0001") };
}

async function simulateCopy(): Promise<void> {
  if (process.platform === "darwin") {
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
      throw new Error(
        "選択テキストを取得するには、システム設定の「プライバシーとセキュリティ > アクセシビリティ」で Gakushu Sochi（開発中は Electron）にコンピュータの制御を許可してください。",
      );
    }
    await execFileAsync("osascript", [
      "-e",
      'tell application "System Events" to tell (first process whose frontmost is true) to key code 8 using {command down}',
    ]);
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')",
    ]);
    return;
  }
  throw new Error(
    "この OS の選択テキスト取得には未対応です。macOS または Windows で実行してください。",
  );
}

export async function openForSelection(): Promise<void> {
  try {
    const selection = await captureSelection({
      readText: () => clipboard.readText(),
      copy: simulateCopy,
      wait: () => new Promise((resolve) => setTimeout(resolve, 250)),
      readClipboard: readClipboardSnapshot,
      // clipboard.read() が返した ClipboardItem はそのまま書き戻せない
      // （「construct a new ClipboardItem to write」で拒否される）。
      // 中身をほどき、同じクラスで新しい ClipboardItem を組み立て直す。
      // ClipboardItem はメインプロセスのグローバルには無いため、
      // 読み出したアイテム自身のコンストラクタを使う。
      writeClipboard: async (items) => {
        if (items.length === 0) {
          clipboard.writeText("");
          return;
        }
        const entries = await toClipboardEntries(items, (type, value) => {
          // 書き戻せない形式は落とすほかないが、黙って消さず理由を残す。
          console.warn(`クリップボードの ${type} は再構築できないため復元しません:`, typeof value);
        });
        // Electron の型定義では ClipboardItem の値は Blob だけだが、
        // bookmark 形式は { title, url } のまま書き戻せる（Electron 44 の仕様）。
        const ClipboardItemClass = items[0]?.constructor as
          | (new (data: Record<string, Blob | ClipboardBookmarkLike>) => Electron.ClipboardItem)
          | undefined;
        if (!ClipboardItemClass || entries.length === 0) return;
        await clipboard.write(
          entries.map(
            (entry) =>
              new ClipboardItemClass(
                Object.fromEntries(entry.map(({ type, value }) => [type, value])),
              ),
          ),
        );
      },
      restoreClipboard: appState.settings.restoreClipboard,
    });
    showPopup(
      selection.length > MAX_SELECTION_LENGTH
        ? selection.slice(0, MAX_SELECTION_LENGTH)
        : selection,
      selection.length > MAX_SELECTION_LENGTH
        ? `長文のため先頭 ${MAX_SELECTION_LENGTH.toLocaleString()} 文字のみを使用します。`
        : undefined,
    );
  } catch (error) {
    showPopup("", error instanceof Error ? error.message : "選択テキストの取得に失敗しました。");
  }
}
