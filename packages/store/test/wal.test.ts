import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startEngine } from "../src/embedded.ts";
import { backupEmbeddedStore, openEmbeddedStore, restoreEmbeddedStore } from "../src/index.ts";
import { opening, removeMade } from "./support/processes.ts";
import { publishSample, sampleOwner } from "./support/sample.ts";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "uketsugi-wal-"));
});
afterAll(async () => {
  await removeMade();
  await rm(root, { recursive: true, force: true });
});

describe("a restored store", () => {
  test("opens without a recovery, and holds every fact acknowledged before the backup was taken", async () => {
    const [from, to, file] = [join(root, "from"), join(root, "to"), join(root, "one.tgz")];
    const source = await openEmbeddedStore({ dataDir: from });
    const owner = await sampleOwner(source);
    const acknowledged: string[] = [];
    for (let n = 1; n <= 5; n += 1) acknowledged.push(await publishSample(source, owner, n));
    // Writes go on while the snapshot is taken; the ones acknowledged before it started must be in it.
    const writing = publishSample(source, owner, 6);
    await backupEmbeddedStore(source, file);
    await writing;
    await source.close();

    await restoreEmbeddedStore({ dataDir: to, file });
    const run = await opening(to);
    run.release(1_000_000);
    await run.ended;

    expect(run.log().filter((line) => line.startsWith("sync worker"))).toEqual([]);
    expect(run.said().filter((said) => said["progress"] !== undefined)).toEqual([]);
    const facts = run.said().flatMap((said) => (said["facts"] as string[] | undefined) ?? []);
    expect(facts).toEqual(expect.arrayContaining(acknowledged));
  });
});

/** Bytes of the engine's log on disk: every file in `pg_wal`. */
async function logSize(engineDir: string): Promise<number> {
  const dir = join(engineDir, "pg_wal");
  const sizes = await Promise.all(
    (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map(async (entry) => (await stat(join(dir, entry.name))).size),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

describe("the log of a running store", () => {
  test("stays within three segments of 16 MB however much is written", async () => {
    const dir = join(root, "log");
    const engine = await startEngine(dir);
    await sql`create table filler (id int, body text)`.execute(engine.db);
    // About 5 MB of log an insert, from text that does not compress: 12 of them are some 60 MB
    // of log, four segments, which nothing would shrink if it were kept until a clean close.
    for (let n = 0; n < 12; n += 1)
      await sql`insert into filler select ${n} * 10 + i, (select string_agg(md5(random()::text || i::text || x::text), '') from generate_series(1, 15000) x) from generate_series(1, 10) i`.execute(
        engine.db,
      );
    const size = await logSize(dir);
    await engine.close();

    expect(size).toBeLessThanOrEqual(3 * 16 * 1024 * 1024 + 1024);
  });
});
