// ipcMain.handle / webContents.send を契約（src/shared/ipc.ts）の型で縛る薄い包み。
// チャネル名と引数・戻り値のずれを型検査で落とすだけで、
// renderer から来る値そのものの実行時検査は各ハンドラが従来どおり担う。
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";

import type {
  EventChannel,
  EventContract,
  InvokeChannel,
  InvokeContract,
} from "../../shared/ipc.js";

type InvokeHandler<C extends InvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: InvokeContract[C]["args"]
) => InvokeContract[C]["result"] | Promise<InvokeContract[C]["result"]>;

export function handle<C extends InvokeChannel>(channel: C, handler: InvokeHandler<C>): void {
  // IPC の引数は renderer 由来の未検証の値。契約の型は「正しく使われたときの形」で、
  // 実行時検査はハンドラ側の責務として残す（検証の強化は Issue #279 ステップ 5）。
  ipcMain.handle(channel, (event, ...args) =>
    handler(event, ...(args as InvokeContract[C]["args"])),
  );
}

export function send<C extends EventChannel>(
  webContents: WebContents | undefined,
  channel: C,
  payload: EventContract[C],
): void {
  webContents?.send(channel, payload);
}
