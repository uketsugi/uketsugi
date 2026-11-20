/**
 * How long a wait inside a test, and a test or hook itself, may last before it counts as a hang:
 * five minutes. A guard decides nothing: a test passes when the state it waits for is there, and a
 * busy machine only makes that later. `vitest.config.ts` sets it as the time limit of every test
 * and hook, and the web tests give it to their queries.
 */
export const HANG_GUARD_MS = 300_000;
