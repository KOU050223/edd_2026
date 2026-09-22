import { createRootRoute, Outlet } from "@tanstack/react-router";
import { ErrorPanel, Pending } from "../errors.js";
import "../style.css";

/**
 * 全ルートの親。ヘッダー付きの枠は `_framed` が持つ。
 *
 * ここで枠を描かないのは `/login-failed` のためである。認可に失敗した画面に
 * 「マップ / 推移 / 設定」への導線を出すと、押しても API が 401 を返すだけになる。
 */
export const Route = createRootRoute({
  component: Outlet,
  errorComponent: ErrorPanel,
  pendingComponent: Pending,
});
