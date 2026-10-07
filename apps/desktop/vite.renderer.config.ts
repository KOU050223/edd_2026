import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// renderer は `loadFile` で file:// から読むので、出力される asset の参照は
// 相対パス（base: "./"）にする。dev server 時はこの設定のまま
// `src/renderer/index.html` がエントリになる。
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../out/renderer", emptyOutDir: true },
});
