import { defineConfig } from "vitest/config";
import { HANG_GUARD_MS } from "./packages/testkit/src/guard.ts";

/**
 * One test run for the whole workspace. Packages resolve each other through the `@uketsugi/source`
 * export condition, so tests run against `src` and need no build. Nothing that needs a harness, a
 * model or a built release is matched here: those run only when asked for, as `*.live.ts` under
 * `deploy/vitest.config.js` and as the store-and-recall suite's `*.check.ts` under
 * `pnpm --filter @uketsugi/e2e recall:check`. Every run has a home directory of its own
 * (`own-home.ts`), so no test can read or write the home of whoever runs it.
 *
 * Half the processors run test files at once, where Vitest's default is all but one. About half
 * the files start the embedded engine, and a new engine is a second of computation that gains
 * nothing from sharing a core. Measured on 6 cores with 12 threads, busy with other work: the first
 * engine of a file took 0.9 s alone, 3.1 s with 6 files at once (the median; 4.3 s at most) and
 * 5.1 to 6.4 s with 11 (9.1 s at most), which is past a test's five seconds and near a hook's ten,
 * while the whole run took 40 s with 6 and 40 to 55 s with 11.
 *
 * A test's and a hook's time limit is a guard against a hang and decides nothing: a test passes when
 * the state it waits for is there, however long a busy machine takes to bring it, and a test or hook
 * that never gets there is stopped after five minutes. The machine that runs the gate is shared:
 * with other work beside it (a load average of 10 to 23) tests that start an engine of their own
 * and take 1 to 1.6 s alone took 4 to 5 s, and at times past 15, which a limit that decided turned
 * into twenty failed files in code no one had touched. A wait inside a test polls for its state
 * and gives up after the same guard (`HANG_GUARD_MS`, which the web tests import).
 *
 * The engine's disk syncs are dropped in every test file but the one about them (`no-disk-sync.ts`).
 */
export default defineConfig({
  resolve: { conditions: ["@uketsugi/source"] },
  ssr: { resolve: { conditions: ["@uketsugi/source"] } },
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/*.test.ts"],
    environment: "node",
    globalSetup: ["packages/testkit/src/own-home.ts"],
    setupFiles: ["packages/store/test/support/no-disk-sync.ts"],
    maxWorkers: "50%",
    testTimeout: HANG_GUARD_MS,
    hookTimeout: HANG_GUARD_MS,
  },
});
