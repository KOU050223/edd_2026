import { readFileSync } from "node:fs";
import path from "node:path";

import { defineConfig, type Plugin } from "vite";

// トレイアイコンを out/main/assets/ へ emit する（Issue #279 ステップ 6）。
// ソースはリポジトリ直下の assets/icons/。macOS のステータスバーは 16pt なので
// 16px を標準解像度、32px を @2x として同じファイル名規則（@2x サフィックス）で
// 置き、Electron の nativeImage が自動で拾う形にする。
const trayIconsPlugin = (): Plugin => ({
  name: "emit-tray-icons",
  apply: "build",
  generateBundle() {
    const iconsDir = path.resolve(import.meta.dirname, "../../assets/icons");
    this.emitFile({
      type: "asset",
      fileName: "assets/tray-icon.png",
      source: readFileSync(path.join(iconsDir, "icon-16.png")),
    });
    this.emitFile({
      type: "asset",
      fileName: "assets/tray-icon@2x.png",
      source: readFileSync(path.join(iconsDir, "icon-32.png")),
    });
  },
});

// Electron の main プロセス向け。ブラウザ向け解決の lib ではなく Node 向け解決の
// ssr ビルドにする（Issue #279 ステップ 3）。`electron` と Node 組み込みは
// Electron 側が提供するので external、`@gakushu-sochi/domain`（CJS パッケージ）は
// バンドルへ含める。
export default defineConfig({
  ssr: {
    external: ["electron"],
    noExternal: ["@gakushu-sochi/domain"],
  },
  plugins: [trayIconsPlugin()],
  build: {
    outDir: "out/main",
    target: "node22",
    ssr: "src/main/index.ts",
  },
});
