import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually } from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  copyOf,
  heldBy,
  opening,
  removeMade,
  writeUntilKilled,
  type Held,
} from "./support/processes.ts";

/**
 * A store whose owner was killed is recovered in a worker thread. Each case starts `open.ts` on a
 * copy of one killed store under the preload that records every sync and holds them
 * (`support/hold-syncs.ts`), so the order of what the threads did is the test's to decide and to
 * read in the log; no case waits on a clock.
 */
const everything = 1_000_000;

let killed: string;
let acknowledged: string[];

beforeAll(async () => {
  killed = await mkdtemp(join(tmpdir(), "uketsugi-recovery-killed-"));
  acknowledged = await writeUntilKilled(killed, (ids) => ids.length === 12);
});
afterAll(async () => {
  await removeMade();
  await rm(killed, { recursive: true, force: true });
});

/** The index in the log of a line that is there, or -1. */
const at = (run: Held, line: string | RegExp): number =>
  run.log().findIndex((entry) => (typeof line === "string" ? entry === line : line.test(entry)));

const progressOf = (run: Held): { phase: string; synced: number; of: number | null }[] =>
  run.said().flatMap((said) => (said["progress"] === undefined ? [] : [said["progress"] as never]));

const factsOf = (run: Held): string[] =>
  run.said().flatMap((said) => (said["facts"] === undefined ? [] : (said["facts"] as string[])));

describe("a killed store", () => {
  test("recovers with no sync on the main thread until the worker is done", async () => {
    const run = await opening(await copyOf(killed));
    run.release(everything);
    await run.ended;

    const recovered = at(run, "recovered");
    expect(recovered).toBeGreaterThan(-1);
    const log = run.log();
    expect(log.slice(0, recovered).filter((line) => line.startsWith("sync main"))).toEqual([]);
    expect(
      log.slice(0, recovered).filter((line) => line.startsWith("sync worker")).length,
    ).toBeGreaterThan(100);
    expect(
      log.slice(recovered).filter((line) => line.startsWith("sync main")).length,
    ).toBeGreaterThan(0);
  });

  test("keeps the main thread turning while a recovery sync is held", async () => {
    const run = await opening(await copyOf(killed), true);
    run.release(2);
    const thread = await heldBy(run, 3);
    // On the main thread nothing can tick, so a sync held there is let go at once and fails below.
    await eventually(() => {
      if (thread === "worker" && !run.log().includes("tick", run.log().indexOf("sync worker 3")))
        throw new Error("no tick since the sync was held");
    });
    run.release(everything);
    await run.ended;

    const log = run.log();
    expect(thread).toBe("worker");
    const held = log.indexOf("sync worker 3");
    expect(log.indexOf("tick", held)).toBeGreaterThan(held);
    expect(log.indexOf("tick", held)).toBeLessThan(log.indexOf(`release ${everything}`));
  });

  test("reports the count rising as syncs are let go, with a phase, and ends on done", async () => {
    const run = await opening(await copyOf(killed));
    run.release(2);
    await heldBy(run, 3);
    await eventually(() => {
      if (!run.over && !progressOf(run).some((p) => p.synced === 2))
        throw new Error("not told yet");
    });
    const before = progressOf(run).at(-1)?.synced;
    run.release(7);
    await heldBy(run, 8);
    await eventually(() => {
      if (!run.over && !progressOf(run).some((p) => p.synced === 7))
        throw new Error("not told yet");
    });
    const after = progressOf(run).at(-1)?.synced;
    run.release(everything);
    await run.ended;

    expect(before).toBe(2);
    expect((after ?? 0) - (before ?? 0)).toBe(5);
    const reports = progressOf(run);
    expect(reports.map((p) => p.phase)).toEqual(
      expect.arrayContaining(["syncing", "replaying", "closing", "done"]),
    );
    for (const { phase, synced, of } of reports) {
      // An estimate is reported only in the phase it covers, and never with more done than it.
      expect(of === null).toBe(phase !== "syncing");
      if (of !== null) expect(synced).toBeLessThan(of);
    }
    expect(reports.at(-1)?.phase).toBe("done");
  });

  test("still holds every fact acknowledged before the SIGKILL", async () => {
    const run = await opening(await copyOf(killed));
    run.release(everything);
    await run.ended;

    expect(progressOf(run).at(-1)?.phase).toBe("done");
    const facts = factsOf(run);
    expect(acknowledged.length).toBeGreaterThanOrEqual(12);
    expect(facts).toEqual(expect.arrayContaining(acknowledged));
  });

  test("a recovery killed while a sync is held is recovered at the next open", async () => {
    const dir = await copyOf(killed);
    const first = await opening(dir);
    first.release(2);
    await heldBy(first, 3);
    first.child.kill("SIGKILL");
    await first.ended;

    const second = await opening(dir);
    second.release(everything);
    await second.ended;

    expect(progressOf(second).at(-1)?.phase).toBe("done");
    const facts = factsOf(second);
    expect(facts).toEqual(expect.arrayContaining(acknowledged));
  });
});

describe("a store shut down cleanly", () => {
  test("opens with no worker: every sync is on the main thread", async () => {
    const dir = await copyOf(killed);
    const recovering = await opening(dir);
    recovering.release(everything);
    await recovering.ended;

    const run = await opening(dir);
    run.release(everything);
    await run.ended;

    const syncs = run.log().filter((line) => line.startsWith("sync"));
    expect(syncs.length).toBeGreaterThan(0);
    expect(syncs.filter((line) => line.startsWith("sync worker"))).toEqual([]);
    expect(progressOf(run)).toEqual([]);
  });
});

describe("a store that cannot be recovered", () => {
  test("fails as StoreUnreadableError and gives the lock back", async () => {
    const dir = await copyOf(killed);
    // A killed store whose version file is gone: the engine cannot start on it.
    await rm(join(dir, "pg", "PG_VERSION"));
    await writeFile(join(dir, "pg", "PG_VERSION"), "");
    await chmod(join(dir, "pg", "PG_VERSION"), 0o600);
    const run = await opening(dir);
    run.release(everything);
    await run.ended;

    expect(run.said()).toContainEqual({ failed: "StoreUnreadableError" });
    expect(run.said()).toContainEqual({ lock: "free" });
  });
});
