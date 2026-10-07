// renderer から見た preload 公開 API の宣言。
// 契約の正本は src/shared/ipc.ts（DesktopApi）。preload が satisfies で
// 満たしているので、ここでは宣言だけを行う。
import type { DesktopApi } from "../shared/ipc.js";

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

export {};
