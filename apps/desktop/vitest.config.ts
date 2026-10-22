import { defineConfig } from "vitest/config";

export default defineConfig({
  // DOM が要るテスト（renderer のフックなど）はファイル先頭の
  // `// @vitest-environment happy-dom` で環境を切り替える。既定は node のまま。
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
