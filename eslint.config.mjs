import { defineConfig, globalIgnores } from "eslint/config";
import eslint from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const clientFiles = ["app/**/*.{ts,tsx}", "local/**/*.{ts,tsx}"];

const eslintConfig = defineConfig([
  globalIgnores([
    "dist-local/**",
    "dist-server/**",
    "logs/**",
    "state/**",
  ]),
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { ...react.configs.flat.recommended, files: clientFiles },
  { ...react.configs.flat["jsx-runtime"], files: clientFiles },
  { ...reactHooks.configs.flat["recommended-latest"], files: clientFiles },
  { ...jsxA11y.flatConfigs.recommended, files: clientFiles },
  {
    files: ["server/**/*.ts", "tests/**/*.mjs", "*.{mjs,ts}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: clientFiles,
    languageOptions: {
      globals: globals.browser,
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  },
]);

export default eslintConfig;
