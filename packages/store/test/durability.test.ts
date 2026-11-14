import { spawn } from "node:child_process";
import { once } from "node:events";
import type * as NodeFs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { scopeOf } from "@uketsugi/core";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { openEmbeddedStore, type EmbeddedStore } from "../src/index.ts";
import { publishSample, sampleOwner } from "./support/sample.ts";

/**
 * The host's `fsync`, counted, in place of the one every other test file has, which drops it
 * (`support/no-disk-sync.ts`). `toDisk` is off while this process only prepares or inspects a
 * directory, so that the disk's flush time is spent where a case is about it and nowhere else.
 */
const synced = vi.hoisted(() => ({ calls: 0, toDisk: false }));

/**
 * The limit of the two steps here that wait on the disk: this process's ten synced commits, and
 * the writer's, which is a process of its own and syncs every one. A sync takes as long as the
 * disk takes: 1 ms on a quiet one, and while other work wrote to it single syncs of 3.9 to 5.9
 * seconds were measured, and 10 seconds for the syncs of one close.
 */
const DISK_WAIT_MS = 30_000;

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  const fsyncSync = (fd: number): void => {
    synced.calls += 1;
    if (synced.toDisk) actual.fsyncSync(fd);
  };
  return { ...actual, fsyncSync };
});

const dataDir = await mkdtemp(join(tmpdir(), "uketsugi-durability-"));
let store: EmbeddedStore;

beforeAll(async () => {
  store = await openEmbeddedStore({ dataDir });
});
afterAll(async () => {
  await store.close();
  await rm(dataDir, { recursive: true, force: true });
});

test(
  "every committed unit is synced to disk before it is acknowledged",
  async () => {
    const owner = await sampleOwner(store);
    synced.toDisk = true;
    try {
      for (let n = 1; n <= 10; n += 1) {
        const before = synced.calls;
        await publishSample(store, owner, n);
        expect(synced.calls).toBeGreaterThan(before);
      }
    } finally {
      synced.toDisk = false;
    }
  },
  DISK_WAIT_MS,
);

describe("a store whose owner is killed while it writes", () => {
  const acknowledged: string[] = [];
  let refusal: unknown;

  beforeAll(async () => {
    await store.close();
    const writer = join(import.meta.dirname, "support", "writer.ts");
    const args = ["--conditions=@uketsugi/source", writer, dataDir, "1000"];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
    for await (const line of createInterface(child.stdout)) {
      acknowledged.push(line);
      if (acknowledged.length === 1) {
        refusal = await openEmbeddedStore({ dataDir }).catch((error: unknown) => error);
      }
      if (acknowledged.length === 12) child.kill("SIGKILL");
    }
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    store = await openEmbeddedStore({ dataDir, lockStaleMs: 2000 });
  }, DISK_WAIT_MS);

  test("a second process is refused while the owner runs, and told what to do", () => {
    expect(String(refusal)).toMatch(
      /is in use by another uketsugi process \(process \d+ on this machine\)\. Stop that process, or give this one its own directory/,
    );
  });

  test("the dead owner's lock is taken over and every acknowledged fact is there", async () => {
    expect(acknowledged.length).toBeGreaterThanOrEqual(12);
    const owner = await sampleOwner(store);
    const found = await store.facts.getMany(scopeOf(owner), acknowledged);
    expect(found.map((fact) => fact.id).sort()).toEqual([...acknowledged].sort());
  });

  test("no unit is half there, and the store takes the next write", async () => {
    const owner = await sampleOwner(store);
    const scope = scopeOf(owner);
    const facts = await store.facts.list(scope, { limit: 1000 });
    const events = await store.review.events(scope, owner.privateAudienceId, 0, 1000);
    expect(events.map((event) => event.subject).sort()).toEqual(
      facts.map((fact) => fact.id).sort(),
    );
    const next = await publishSample(store, owner, 5000);
    expect((await store.facts.get(scope, next))?.id).toBe(next);
  });
});
