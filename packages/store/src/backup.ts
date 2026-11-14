/**
 * Backup and restore of an embedded store, for the command line. A snapshot is one file: a gzipped
 * tarball of the engine's directory, vectors included, so a restore rebuilds nothing. A server
 * deployment uses PostgreSQL's own tools instead.
 */
import { existsSync } from "node:fs";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ENGINE_DIR,
  INCOMING_DIR,
  OUTGOING_DIR,
  lockDataDir,
  settleRestore,
  writeSnapshot,
} from "./data-dir.ts";
import { startEngine, type EmbeddedStore } from "./embedded.ts";
import { migrate } from "./migrations.ts";

/**
 * Writes a snapshot of a running store to `file` and returns its size in bytes. The store keeps
 * serving: the snapshot is taken between two statements and holds every unit committed before it.
 * The whole snapshot passes through memory.
 */
export async function backupEmbeddedStore(store: EmbeddedStore, file: string): Promise<number> {
  return writeSnapshot(file, await store.snapshot());
}

export interface RestoreOptions {
  /** The data directory whose store the snapshot replaces. It need not exist yet. */
  readonly dataDir: string;
  /** A file `backupEmbeddedStore` wrote. */
  readonly file: string;
}

/** Syncs a directory, so that a rename inside it survives a power cut. Not every platform can. */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  await handle.sync().catch(() => undefined);
  await handle.close();
}

/**
 * Replaces the store in a data directory with a snapshot. It takes the directory's lock, so it
 * refuses while a server runs on the directory. The snapshot is loaded beside the store and
 * brought to this version's schema before anything is replaced: a snapshot that cannot be read,
 * or that a newer version wrote, leaves the store as it was.
 */
export async function restoreEmbeddedStore(options: RestoreOptions): Promise<void> {
  const { dataDir } = options;
  const release = await lockDataDir(dataDir);
  try {
    await settleRestore(dataDir);
    const incoming = join(dataDir, INCOMING_DIR);
    try {
      const engine = await startEngine(incoming, new Blob([await readFile(options.file)]));
      try {
        await migrate(engine.db);
      } finally {
        await engine.close();
      }
    } catch (error) {
      await rm(incoming, { recursive: true, force: true });
      throw new Error(
        `The snapshot ${options.file} could not be restored. The store is unchanged.`,
        { cause: error },
      );
    }
    const [engineDir, outgoing] = [join(dataDir, ENGINE_DIR), join(dataDir, OUTGOING_DIR)];
    if (existsSync(engineDir)) await rename(engineDir, outgoing);
    await rename(incoming, engineDir);
    await syncDirectory(dataDir);
    await rm(outgoing, { recursive: true, force: true });
  } finally {
    await release();
  }
}
