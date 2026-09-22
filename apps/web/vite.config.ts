import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

export default defineConfig({
  plugins: [
    // `tanstackRouter` は `react` より前に置く。順序を逆にすると
    // ルート生成とコード分割が**黙って効かなくなる**（エラーは出ない）。
    //
    // 既定の探索先は `src/routes` だが、このアプリは `src/worker` と
    // `src/client` を分けているので、クライアント側を明示する。
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "./src/client/routes",
      generatedRouteTree: "./src/client/routeTree.gen.ts",
    }),
    react(),
  ],
  build: { outDir: "dist/client" },
});
