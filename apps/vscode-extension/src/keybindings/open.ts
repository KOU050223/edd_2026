import type { ExecuteCommand } from "../chat/open";

/**
 * VS Code 標準の「キーボードショートカット」設定を、この拡張のコマンドで
 * 絞り込んだ状態で開く。
 *
 * 既定のキーバインド（`contributes.keybindings`）はあくまで既定値であり、
 * 利用者は標準の `keybindings.json` から上書きできる。足りないのは変更する
 * 手段ではなく、その設定画面へ辿り着く導線なので、独自の設定画面は作らない
 * （#34）。
 */
const OPEN_GLOBAL_KEYBINDINGS = "workbench.action.openGlobalKeybindings";

/**
 * 検索欄へ入れる絞り込み文字列。コマンド ID の接頭辞で引くと、この拡張が
 * 配る 3 つの入力経路だけが並ぶ。
 */
const COMMAND_PREFIX = "gakushuSochi.";

export async function openGakushuSochiKeybindings(executeCommand: ExecuteCommand): Promise<void> {
  await executeCommand(OPEN_GLOBAL_KEYBINDINGS, COMMAND_PREFIX);
}
