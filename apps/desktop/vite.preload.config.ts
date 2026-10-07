import { defineConfig } from "vite";

// preload は sandbox 付きの renderer 内で読まれるため、ESM や複数ファイルに
// 分かれた出力は使えない。必ず CJS の単一ファイル（index.cjs）で出す。
// `electron` は preload 側でも外部提供なので external にする。
export default defineConfig({
  build: {
    outDir: "out/preload",
    lib: {
      entry: "src/preload/index.cts",
      formats: ["cjs"],
      fileName: () => "index.cjs",
    },
    rollupOptions: { external: ["electron"] },
  },
});
