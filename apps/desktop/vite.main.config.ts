import { defineConfig } from "vite";

// Electron の main プロセス向け。ブラウザ向け解決の lib ではなく Node 向け解決の
// ssr ビルドにする（Issue #279 ステップ 3）。`electron` と Node 組み込みは
// Electron 側が提供するので external、`@gakushu-sochi/domain`（CJS パッケージ）は
// バンドルへ含める。
export default defineConfig({
  ssr: {
    external: ["electron"],
    noExternal: ["@gakushu-sochi/domain"],
  },
  build: {
    outDir: "out/main",
    target: "node22",
    ssr: "src/main/index.ts",
  },
});
