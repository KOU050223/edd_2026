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
    // RULE-004 の再発防止: エラーを黙って捨てる .catch(() => {}) /
    // .catch(() => undefined) 形を禁止する。隔離はしても飲み込まない。
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='catch'] > :matches(ArrowFunctionExpression, FunctionExpression)[body.type='BlockStatement'][body.body.length=0]",
          message:
            "RULE-004: エラーを握りつぶす空の catch コールバックは禁止です。隔離しても飲み込まないよう、理由を console.warn などに残してください。",
        },
        {
          selector:
            "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='Identifier'][body.name='undefined']",
          message:
            "RULE-004: エラーを握りつぶす catch コールバックは禁止です。隔離しても飲み込まないよう、理由を console.warn などに残してください。",
        },
        {
          selector:
            "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='Literal'][body.value=null]",
          message:
            "RULE-004: エラーを握りつぶす catch コールバックは禁止です。隔離しても飲み込まないよう、理由を console.warn などに残してください。",
        },
      ],
    },
  },
  {
    // 型情報を使う Promise の検査（Issue #279 ステップ 7）。
    // 待ち忘れ（floating）と、void を期待する位置への Promise 渡しを止める。
    // 意図的に待たない呼び出しは void を付け、理由が自明でなければコメントを添える。
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
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
