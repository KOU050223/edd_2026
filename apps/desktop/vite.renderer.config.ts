import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// renderer は本番で app://renderer/ スキームから配る。asset の参照は相対パス
// （base: "./"）のままにしておき、dev server・独自スキームのどちらでも解決できる
// ようにする。dev server 時はこの設定のまま `src/renderer/index.html` がエントリになる。

// 本番ビルドの index.html にだけ CSP を入れる（Issue #279 ステップ 5）。
// dev は React Refresh がインラインスクリプトを差すので入れない。
// style-src に 'unsafe-inline' を足さない: React の style={...} は
// CSSStyleDeclaration 経由の代入で style 属性を書かないため CSP に抵触しない。
const cspPlugin = (): Plugin => ({
  name: "inject-renderer-csp",
  apply: "build",
  transformIndexHtml(html) {
    const policy = [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "object-src 'none'",
    ].join("; ");
    return html.replace(
      "<head>",
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
    );
  },
});

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react(), cspPlugin()],
  build: { outDir: "../../out/renderer", emptyOutDir: true },
});
