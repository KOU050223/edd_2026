import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// VS Code の ESLint 拡張はモノレポのルートとこのアプリの両方を候補にできる。
// 型情報を使うルールを追加しても tsconfig の探索先が曖昧にならないよう、
// この設定ファイルがあるディレクトリを明示する。
const tsconfigRootDir = import.meta.dirname;

export default [
  {
    ignores: ["out/**", "node_modules/**"],
    languageOptions: {
      parserOptions: { tsconfigRootDir },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // ビルドスクリプトはNode上で直接実行する。console / process はNodeのグローバル。
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly" },
    },
  },
  {
    // AI層はエディタから独立させる。CodeContext というデータのみを受け取り、
    // vscode に依存させない。将来 VS Code 以外へ展開する余地を機械的に守るためのルール。
    // 基盤/04 (#3) を参照。
    //
    // vscodeLm.ts は例外。vscode.lm を呼ぶこと自体が AI/02 (#11) の実装対象であり、
    // AIProvider interface の実装として他から差し替え可能であればよい
    // （呼び出し側の provider.ts / mock.ts が vscode非依存であることが本来の目的）。
    files: ["src/ai/**/*.ts"],
    ignores: ["src/ai/vscodeLm.ts", "src/ai/vscode-lm.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "vscode",
              message:
                "src/ai/ は vscode に依存させない。エディタ固有の情報は CodeContext 経由で受け取ること。",
            },
          ],
        },
      ],
    },
  },
];
