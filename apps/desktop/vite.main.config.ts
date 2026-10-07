import { builtinModules } from "node:module";
import { defineConfig } from "vite";

// Electron の main プロセス向け。`electron` と Node 組み込みモジュールは
// Electron 側が提供するので external にし、`@gakushu-sochi/domain`
// （CJS パッケージ）はバンドルへ含める。
const external = ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

export default defineConfig({
  build: {
    outDir: "out/main",
    target: "node22",
    lib: {
      entry: "src/main/index.ts",
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: { external },
  },
});
