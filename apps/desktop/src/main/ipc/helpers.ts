// ipcMain.handle / webContents.send を契約（src/shared/ipc.ts）の型で縛る薄い包み。
// 登録にはチャネルごとのスキーマ（ipc/schemas.ts）が必須で、renderer から届いた
// 未検証の引数をスキーマで検査してからハンドラへ渡す。
// あわせて送信元がこのアプリの renderer 自身（appState.popup の webContents・
// 期待する URL の frame）であることを検証する（Issue #279 ステップ 5）。
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";

import * as v from "valibot";

import { appState } from "../app-state.js";
import { RENDERER_INDEX_URL } from "../renderer-scheme.js";
import type {
  EventChannel,
  EventContract,
  InvokeChannel,
  InvokeContract,
} from "../../shared/ipc.js";
import { isTrustedIpcSender } from "./sender.js";

type InvokeHandler<C extends InvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: InvokeContract[C]["args"]
) => InvokeContract[C]["result"] | Promise<InvokeContract[C]["result"]>;

/**
 * 許可する renderer の URL。dev server が検証済みであればその origin を使い、
 * それ以外（本番・dev server 無しの起動）は app://renderer/ の origin。
 */
function allowedRendererUrl(): string {
  return appState.rendererDevServerUrl ?? RENDERER_INDEX_URL;
}

function assertTrustedSender(channel: string, event: IpcMainInvokeEvent): void {
  const ok = isTrustedIpcSender({
    frameUrl: event.senderFrame?.url,
    sender: event.sender,
    expectedSender: appState.popup?.webContents,
    allowedUrl: allowedRendererUrl(),
  });
  if (!ok) {
    throw new Error(`${channel} の呼び出し元がこのアプリの renderer ではありません。`);
  }
}

export function handle<C extends InvokeChannel>(
  channel: C,
  schema: v.GenericSchema<unknown, InvokeContract[C]["args"]>,
  handler: InvokeHandler<C>,
): void {
  // IPC の引数は renderer 由来の未検証の値。送信元を確かめ、スキーマで
  // 実行時検査してからハンドラへ渡す。どちらも通らない呼び出しは例外にする
  // （黙って undefined を返さない）。スキーマの出力型は契約の args に
  // 結びついているので、ここにキャストは要らない。
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    assertTrustedSender(channel, event);
    const parsed = v.safeParse(schema, args);
    if (!parsed.success) {
      throw new Error(`${channel} の引数が不正です: ${v.summarize(parsed.issues)}`);
    }
    return handler(event, ...parsed.output);
  });
}

export function send<C extends EventChannel>(
  webContents: WebContents | undefined,
  channel: C,
  payload: EventContract[C],
): void {
  // 破棄済みの webContents への送信はレンダラーが無い＝届け先が無いという
  // 想定内の状況なので、例外にせずイベントを落とす（破棄時の中断処理が
  // 残りの delta を送ろうとしうる）。isDestroyed() なしの send は
  // Electron が例外を投げるか無警告で落とすため、ここで明示的に弾く。
  if (webContents === undefined || webContents.isDestroyed()) return;
  webContents.send(channel, payload);
}
