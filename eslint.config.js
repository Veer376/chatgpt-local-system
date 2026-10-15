import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", ".venv/**", "coverage/**", ".safari-ios/**", "examples/python-minimal/**", "extensions/local-system/vendor/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-console": "off",
      "no-empty": ["error", { "allowEmptyCatch": true }],
      "no-unused-vars": ["error", { "argsIgnorePattern": "^_", "caughtErrorsIgnorePattern": "^_" }],
      "eqeqeq": ["error", "smart"],
    },
  },
];
