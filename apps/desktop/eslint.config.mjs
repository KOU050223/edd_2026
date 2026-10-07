import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default [
  { ignores: ["out/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ["src/renderer/**/*.{js,ts,tsx}"],
    languageOptions: {
      globals: { document: "readonly", window: "readonly", navigator: "readonly" },
    },
  },
  {
    // renderer の React コードだけに Hooks の規則をかける。
    // web 側はこのプラグインを使っていないため、ここで新規に足す
    // （useDesktopEvent など、依存配線の誤りをコンパイルより早く止める）。
    // recommended（React Compiler 由来の refs / set-state-in-effect 等を含む）で、
    // ref のレンダー中書き換えも検出する。
    files: ["src/renderer/**/*.{ts,tsx}"],
    ...reactHooks.configs.flat.recommended,
  },
  {
    // src/shared は renderer からも読む正本。Electron・Node・main/preload へ
    // 依存すると renderer 用の型検査まで Node の世界へ入り込むため禁止する
    // （Issue #279 ステップ 3）。許されるのは domain と shared 内だけ。
    // テストファイルは vitest（Node）でしか実行されず renderer へ同梱されないため除く。
    files: ["src/shared/**/*.ts"],
    ignores: ["src/shared/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../main/**", "../preload/**"],
              message:
                "src/shared は main/preload に依存できません。DTO は src/shared/types.ts に置きます。",
            },
            {
              group: ["electron", "electron/**", "node:*"],
              message: "src/shared は renderer からも読みます。electron と Node API は使えません。",
            },
          ],
        },
      ],
    },
  },
];
