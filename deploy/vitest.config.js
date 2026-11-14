/**
 * The tests that need this machine rather than a fake: the real embedding model, and a release
 * built and installed into an empty home directory. They are not part of `pnpm test`. From the
 * workspace root, with a model directory (one `ukt setup` made) in UKT_MODEL_DIR:
 *
 *   UKT_MODEL_DIR=<dir> pnpm vitest run -c deploy/vitest.config.js           # both
 *   UKT_MODEL_DIR=<dir> pnpm vitest run -c deploy/vitest.config.js install   # the install test
 */
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: join(import.meta.dirname, ".."),
  resolve: { conditions: ["@uketsugi/source"] },
  ssr: { resolve: { conditions: ["@uketsugi/source"] } },
  test: {
    include: ["packages/*/test/**/*.live.ts"],
    environment: "node",
    // Building a release and running a model over hundreds of texts take longer than a unit test may.
    testTimeout: 120_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
