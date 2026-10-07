import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

// VS Code の ESLint 拡張は eslint.workingDirectories の auto 検出により、
// モノレポのルートとこのワークスペースの両方を候補にできる。候補が複数あると
// tsconfig の探索先が決まらず、エディタ上でパースエラーになる。
// この設定ファイルがあるディレクトリを明示する（apps/vscode-extension と同じ対処）。
const tsconfigRootDir = import.meta.dirname;

export default [
  {
    ignores: ["node_modules/**", "src/worker-configuration.d.ts"],
    languageOptions: {
      parserOptions: { tsconfigRootDir },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // Effect はバンドルへの取り込み方で大きさが桁で変わる（実測、minify 後）。
    // - `from "effect"` のまとめ import は tree-shaking が効ききらない。サブパスなら 82 → 24 KiB。
    // - `Schema` は 1 つ使うだけで約 200 KiB を引き込む。エラーは `Data.TaggedError` で定義する。
    // 詳細はルートの AGENTS.md「Effect」。
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "effect",
              message:
                'Effect はサブパスから import する（例: import * as Effect from "effect/Effect"）。まとめ import はバンドルが膨らむ。',
            },
          ],
          patterns: [
            {
              group: ["effect/Schema", "effect/SchemaAST"],
              message:
                "Schema は約 200 KiB を引き込む。エラーは Data.TaggedError で定義する。検証に Schema を使うなら、サイズを測ったうえで方針として決めてから外すこと。",
            },
          ],
        },
      ],
    },
  },
];
