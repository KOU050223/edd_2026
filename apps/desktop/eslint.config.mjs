import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default [
  { ignores: ["out/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ["src/renderer/**/*.js"],
    languageOptions: {
      globals: { document: "readonly", window: "readonly", navigator: "readonly" },
    },
  },
];
