import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Which workspace package may import which is each `package.json`'s to say: pnpm links only what a
 * package lists, and the compiler refuses the rest. Two rules need saying here, because a listed
 * development dependency is importable from `src` too.
 */
const TEST_PACKAGES = {
  group: ["@uketsugi/testkit", "@uketsugi/testkit/*", "@uketsugi/e2e", "@uketsugi/e2e/*"],
  message: "Source that ships may not import testkit or e2e: they are test packages.",
};
const NODE_MODULES = {
  regex: "^node:",
  message: "contracts and core do no I/O: reach the outside through a port.",
};

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true }],
      complexity: ["error", 15],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Ports are asynchronous so that a networked adapter fits them; a synchronous adapter still returns promises.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // A test's `describe` block and a conformance suite are lists of cases, not one function's logic.
    files: ["packages/*/test/**", "packages/testkit/src/conformance/**"],
    rules: { "max-lines-per-function": "off" },
  },
  {
    // Core reads the clock and random numbers only through its ports.
    files: ["packages/core/src/**"],
    rules: {
      "no-restricted-globals": ["error", "process", "Buffer", "setTimeout", "setInterval", "fetch"],
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "Read time through the Clock port." },
        { object: "Math", property: "random", message: "Take randomness through the IdGen port." },
        { object: "crypto", property: "randomUUID", message: "Take ids through the IdGen port." },
        {
          object: "crypto",
          property: "getRandomValues",
          message: "Take randomness through the IdGen port.",
        },
        {
          object: "AbortSignal",
          property: "timeout",
          message: "Take time limits through the Clock port.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "Read time through the Clock port.",
        },
      ],
    },
  },
  {
    files: ["packages/*/src/**"],
    ignores: ["packages/testkit/**", "packages/e2e/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [TEST_PACKAGES] }] },
  },
  {
    files: ["packages/core/src/**", "packages/contracts/src/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [TEST_PACKAGES, NODE_MODULES] }] },
  },
  {
    // Written by `pnpm generate` from the contract's schema: its length is the schema's.
    files: ["packages/contracts/src/generated.ts"],
    rules: { "max-lines": "off" },
  },
  { files: ["**/*.js"], extends: [tseslint.configs.disableTypeChecked] },
);
