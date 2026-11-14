/**
 * Vitest set-up for every test file in the workspace (`vitest.config.ts`): the embedded engine's
 * syncs are dropped in the test's own process.
 *
 * A sync holds the calling thread for as long as the disk takes. That is 1 ms on a quiet disk; on
 * one that other work is writing to, single syncs of 3.9 to 5.9 seconds were measured, and a new
 * store's first start, which is five of them, took 13 to 16 seconds, for nothing the case was
 * about. A store that is closed and opened again reads what it wrote either way, so only a case
 * about the disk needs the sync, and those keep it: `durability.test.ts` replaces this with its
 * own counted one, and a process a test starts does not have this file.
 */
import type * as NodeFs from "node:fs";
import { vi } from "vitest";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return { ...actual, fsyncSync: () => undefined };
});
