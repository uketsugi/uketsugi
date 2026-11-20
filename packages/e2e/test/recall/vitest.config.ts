/**
 * The checks of the live end-to-end suite (store and recall) itself: they start the sandbox, clone
 * ergo and build the release, and some start real harness sessions. They are not part of `pnpm test`
 * or `pnpm check`, and not of the release checks in `deploy/vitest.config.js`: only this command
 * collects them, from the workspace root or the package:
 *
 *   pnpm --filter @uketsugi/e2e recall:check
 *
 * The session checks need the sign-in (CLAUDE_CODE_OAUTH_TOKEN, or CLAUDE_SIGN_IN) and a model
 * directory (UKT_MODEL_DIR); the model-step check needs UKT_RECALL_LLM_KEY_FILE. A check that lacks
 * what it needs fails and says what.
 */
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: join(import.meta.dirname, "..", "..", "..", ".."),
  resolve: { conditions: ["@uketsugi/source"] },
  ssr: { resolve: { conditions: ["@uketsugi/source"] } },
  test: {
    include: ["packages/e2e/test/recall/**/*.check.ts"],
    environment: "node",
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
    fileParallelism: false,
  },
});
