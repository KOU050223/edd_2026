// ipcRenderer.invoke / ipcRenderer.on を契約（src/shared/ipc.ts）の型で縛る薄い包み。
// sandbox 付き preload でも使える API（invoke / on / removeListener）だけを使う。
import { ipcRenderer, type IpcRendererEvent } from "electron";

import type { EventChannel, EventContract, InvokeChannel, InvokeContract } from "../shared/ipc.js";

export function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeContract[C]["args"]
): Promise<InvokeContract[C]["result"]> {
  return ipcRenderer.invoke(channel, ...args);
}

// 登録解除の関数を返す。React の useEffect の後始末にそのまま渡せる形（Issue #279）。
export function on<C extends EventChannel>(
  channel: C,
  listener: (payload: EventContract[C]) => void,
): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: EventContract[C]) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}
