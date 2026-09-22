import { createRouter, RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { routeTree } from "./routeTree.gen";

const router = createRouter({
  routeTree,
  // リンクにポインタが乗った時点で loader を走らせる。押したときには
  // 取得が終わっているので、画面の切り替えが待ち時間なしで済む。
  defaultPreload: "intent",
  // 学習データは頻繁に変わらない。一度取ったものを 30 秒は再利用し、
  // 画面を往復するたびに取り直さない。保存後は `router.invalidate()` で明示的に捨てる。
  defaultStaleTime: 30_000,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
