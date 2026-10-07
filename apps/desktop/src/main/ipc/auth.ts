// auth:* のハンドラ登録（Issue #279 ステップ 3 で index.ts から分離）。
import { loginWithBrowser, logout } from "../auth/index.js";
import { INVOKE_CHANNELS } from "../../shared/ipc.js";
import { handle } from "./helpers.js";

export function registerAuthIpc(): void {
  handle(INVOKE_CHANNELS.authLogin, loginWithBrowser);
  handle(INVOKE_CHANNELS.authLogout, logout);
}
