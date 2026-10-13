import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "**/*.tsbuildinfo", "**/.next/**", "**/.expo/**", "**/test-results/**", "**/playwright-report/**", "**/dist-*/**", "**/web-build/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["db/scripts/**/*.ts", "apps/*/scripts/**/*.ts", "apps/*/scripts/**/*.mjs"],
    rules: { "no-console": "off" },
  },
  {
    // Node scripts; the smoke test also passes callbacks into the browser page.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly", process: "readonly", performance: "readonly", Buffer: "readonly", fetch: "readonly", setTimeout: "readonly", URL: "readonly",
        window: "readonly", document: "readonly", Event: "readonly",
      },
    },
  },
  {
    // Metro's config is loaded by Node as CommonJS.
    files: ["**/metro.config.js"],
    languageOptions: { sourceType: "commonjs", globals: { require: "readonly", module: "writable", __dirname: "readonly" } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // Service worker scope.
    files: ["apps/web/public/sw.js"],
    languageOptions: {
      sourceType: "script",
      globals: { self: "readonly", caches: "readonly", fetch: "readonly", URL: "readonly", Response: "readonly", Request: "readonly" },
    },
  },
);
