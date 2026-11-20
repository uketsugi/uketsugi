import { vi } from "vitest";
import { HANG_GUARD_MS } from "./guard.ts";

/**
 * Runs `check` until it stops throwing, and gives back what it returned: a wait for a state, which
 * a busy machine only makes later. It gives up only at the hang guard.
 */
export function eventually<T>(check: () => T | Promise<T>, interval = 50): Promise<T> {
  return vi.waitFor(check, { timeout: HANG_GUARD_MS, interval });
}
