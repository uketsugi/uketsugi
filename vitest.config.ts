import { defineConfig } from "vitest/config";

/**
 * One test run for the whole workspace. Packages resolve each other through the `@uketsugi/source`
 * export condition, so tests run against `src` and need no build. Live harness runners live under
 * `packages/e2e/live` and are not matched here. Every run has a home directory of its own
 * (`own-home.ts`), so no test can read or write the home of whoever runs it.
 *
 * Half the processors run test files at once, where Vitest's default is all but one. About half
 * the files start the embedded engine, and a new engine is a second of computation that gains
 * nothing from sharing a core. Measured on 6 cores with 12 threads, busy with other work: the first
 * engine of a file took 0.9 s alone, 3.1 s with 6 files at once (the median; 4.3 s at most) and
 * 5.1 to 6.4 s with 11 (9.1 s at most), which is past a test's five seconds and near a hook's ten,
 * while the whole run took 40 s with 6 and 40 to 55 s with 11.
 *
 * A test has 15 seconds and a hook 30, three times Vitest's defaults: the limits are of the clock,
 * and the machine that runs the gate is shared. With a second full run beside this one and other
 * work besides (a load average of 21 to 25), tests that start an engine of their own and take 1.0 to
 * 1.6 s alone took 4.0 to 5.1 s, in the store, the command line and the end-to-end cases alike. A
 * test that needs longer still says why where it asks for it.
 *
 * The engine's disk syncs are dropped in every test file but the one about them (`no-disk-sync.ts`).
 */
export default defineConfig({
  resolve: { conditions: ["@uketsugi/source"] },
  ssr: { resolve: { conditions: ["@uketsugi/source"] } },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    globalSetup: ["packages/testkit/src/own-home.ts"],
    setupFiles: ["packages/store/test/support/no-disk-sync.ts"],
    maxWorkers: "50%",
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
