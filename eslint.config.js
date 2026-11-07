/**
 * Shared flat ESLint configuration for all TypeScript packages under apps/*.
 * ESLint 9+ requires flat config (eslint.config.js) -- the legacy .eslintrc.*
 * format is no longer supported. Individual packages MUST NOT redefine rules
 * already set here (Constitution Principle IV: no duplicated logic).
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/dist/", "**/node_modules/", "**/*.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/*/src/**/*.ts", "apps/*/tests/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
    },
  },
  prettier,
);
