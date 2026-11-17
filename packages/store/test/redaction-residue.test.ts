/**
 * What a redaction leaves behind, for a person deciding whether a pasted secret is gone. The text
 * leaves every table. On the embedded store it can stay in the engine's own files, and so in a
 * backup made afterwards, until the engine rewrites the pages the old row sat on; the README says
 * so, and these cases hold it to what a run showed.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Store } from "@uketsugi/core";
import {
  createTestDatabase,
  fakeUuid,
  onTestServer,
  sampleEvent,
  sampleFactContent,
  SAMPLE_PROJECT,
  targetOf,
  TEST_POSTGRES_URL,
} from "@uketsugi/testkit";
import { afterAll, describe, expect, test } from "vitest";
import { backupEmbeddedStore, openEmbeddedStore } from "../src/index.ts";
import { openServerStore } from "../src/server-postgres.ts";
import { sampleOwner } from "./support/sample.ts";

const SECRET = "hunter2-the-pasted-password-9f3a1c";
const AT = new Date("2026-01-01T00:00:00.000Z");
const root = await mkdtemp(join(tmpdir(), "uketsugi-residue-"));
afterAll(() => rm(root, { recursive: true, force: true }));

/** Publishes a fact whose claim holds the secret, then redacts it; returns the redacted ids. */
async function publishAndRedact(store: Store): Promise<string[]> {
  const owner = await sampleOwner(store);
  const id = fakeUuid(1, 1);
  const target = targetOf(owner, AT);
  await store.unit(target, async (unit) => {
    const fact = { id, project: SAMPLE_PROJECT, author: owner.principalId };
    const content = sampleFactContent(`The deploy password is ${SECRET}`);
    await unit.facts.insert({ ...fact, content, vector: null });
    await unit.append(sampleEvent(id, owner.principalId));
  });
  return store.unit(target, (unit) => unit.facts.redact(id));
}

/** The files under a directory that hold the text, raw or inside a gzip, by path. */
async function filesHolding(dir: string, text: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const bytes = await readFile(path);
    if (bytes.includes(text)) found.push(path);
  }
  return found;
}

describe("a redacted text in the embedded store", () => {
  test("is out of the store, and is still in its files and in a backup made afterwards", async () => {
    const dataDir = join(root, "embedded");
    const store = await openEmbeddedStore({ dataDir });
    expect(await publishAndRedact(store)).toHaveLength(1);
    const backup = join(root, "after.tar.gz");
    await backupEmbeddedStore(store, backup);
    await store.close();

    const inFiles = await filesHolding(dataDir, SECRET);
    const inBackup = gunzipSync(await readFile(backup)).includes(SECRET);
    // The engine's write-ahead log, and the page of the table the old row sat on.
    expect(inFiles.map((f) => f.slice(dataDir.length)).sort()).toEqual([
      expect.stringMatching(/^\/pg\/base\//),
      expect.stringMatching(/^\/pg\/pg_wal\//),
    ]);
    expect(inBackup).toBe(true);
  });
});

describe.runIf(TEST_POSTGRES_URL !== "")("a redacted text on PostgreSQL", () => {
  test("is out of every table", async () => {
    const database = await createTestDatabase();
    try {
      const store = await openServerStore({ connectionString: database.url });
      expect(await publishAndRedact(store)).toHaveLength(1);
      await store.close();
      const tables = (await onTestServer(
        "select tablename from pg_tables where schemaname = 'public'",
        database.name,
      )) as { tablename: string }[];
      const holding: string[] = [];
      for (const { tablename } of tables) {
        const rows = await onTestServer(`select t::text as r from "${tablename}" t`, database.name);
        if (JSON.stringify(rows).includes(SECRET)) holding.push(tablename);
      }
      expect(tables.length).toBeGreaterThan(10);
      expect(holding).toEqual([]);
    } finally {
      await database.drop();
    }
  });
});
