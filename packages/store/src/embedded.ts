/**
 * The embedded engine: PGlite, PostgreSQL in WebAssembly, with pgvector and pg_trgm. This file is
 * the only one that knows it. It runs on the calling thread: a statement holds the thread for as
 * long as it runs, and between statements the event loop gets a turn.
 *
 * Four things the engine does not do by itself are done here:
 * - A commit reaches the disk. The engine ships with `fsync` off, and its file layer has no
 *   `fsync` at all, so `SyncedNodeFs` adds one and the start parameters turn it on.
 * - The log is checkpointed. Single-user mode never does it, so `pg_wal` would keep everything
 *   written since the last clean close.
 * - The data directory has one owner (`data-dir.ts`).
 * - An existing store about to take new migrations is snapshotted first.
 */
import { fsyncSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { PGlite, types } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { NodeFS } from "@electric-sql/pglite/nodefs";
import { vector } from "@electric-sql/pglite-pgvector";
import type { Store } from "@uketsugi/core";
import { PGliteDialect, PGliteDriver, type Dialect, type KyselyPlugin } from "kysely";
import type { Migration } from "kysely/migration";
import { connect, type Db } from "./codec.ts";
import {
  ENGINE_DIR,
  keepUpgradeSnapshot,
  lockDataDir,
  settleRestore,
  StoreUnreadableError,
  usable,
} from "./data-dir.ts";
import { migrate, migrationState, MIGRATIONS } from "./migrations.ts";
import { recoverEngine, type RecoveryProgress } from "./recovery.ts";
import { createStore } from "./store.ts";

export interface EmbeddedStoreOptions {
  /**
   * The data directory. One process owns it: a second opener is refused. Left out, the store lives
   * in memory and is gone when it closes, which is what a test wants.
   */
  readonly dataDir?: string;
  /** How old an unrefreshed lock must be before it is taken over. Ten seconds unless given. */
  readonly lockStaleMs?: number;
  /**
   * Told how far the recovery of a store that was not shut down cleanly has got. It runs off the
   * main thread, so the process keeps answering while it does; a clean store makes no report.
   */
  readonly onRecovery?: (progress: RecoveryProgress) => void;
}

/** The embedded store: the Store port, and a snapshot of itself while it runs. */
export interface EmbeddedStore extends Store {
  /**
   * A consistent copy of the whole store, vectors included, as a gzipped tarball of the engine's
   * directory. It is taken between statements: a unit that has not committed is not in it.
   */
  snapshot(): Promise<Blob>;
}

/** The engine with a database handle on it: what the store, the backup and the restore share. */
export interface Engine {
  readonly db: Db;
  snapshot(): Promise<Blob>;
  close(): Promise<void>;
}

/** What the fsync fix reaches inside Emscripten's NODEFS. */
interface NodeFsInternals {
  readonly stream_ops: { fsync?: (stream: { readonly nfd: number }) => number };
  /** Runs a host file operation and turns its failure into the error code the engine expects. */
  tryFSOperation<T>(operation: () => T): T;
}

/** The engine's module, as far as the fix reads it; the engine's own types leave this part open. */
interface EngineModule {
  readonly FS: { readonly filesystems: { readonly NODEFS: NodeFsInternals } };
}

/**
 * The engine's Node file system plus the one operation it lacks. Emscripten's NODEFS has no
 * `fsync`, so the engine's `fsync` returned without syncing; here it syncs the host descriptor.
 */
class SyncedNodeFs extends NodeFS {
  readonly #onSync: () => void;

  /** `onSync` is told after each sync. */
  constructor(dataDir: string, onSync: () => void) {
    super(dataDir);
    this.#onSync = onSync;
  }

  override async init(...args: Parameters<NodeFS["init"]>): ReturnType<NodeFS["init"]> {
    const { emscriptenOpts } = await super.init(...args);
    const onSync = this.#onSync;
    const addFsync: NonNullable<typeof emscriptenOpts.preRun>[number] = (mod) => {
      const nodefs = (mod as unknown as EngineModule).FS.filesystems.NODEFS;
      nodefs.stream_ops.fsync = (stream) => {
        nodefs.tryFSOperation(() => fsyncSync(stream.nfd));
        onSync();
        return 0;
      };
    };
    return {
      emscriptenOpts: { ...emscriptenOpts, preRun: [...(emscriptenOpts.preRun ?? []), addFsync] },
    };
  }
}

/**
 * `wal_sync_method`: the engine's default, `fdatasync`, does nothing under Emscripten. The buffer
 * pool is 16 MB instead of 128 MB: a scan of 20,000 facts takes the same time, in 120 MB less.
 */
const SETTINGS = ["wal_sync_method = fsync", "shared_buffers = 16MB"];

/** The engine's start parameters without `-F`, which turns fsync off, and with it turned on. */
const DURABLE_START = [...PGlite.defaultStartParams.filter((p) => p !== "-F"), "-c", "fsync=on"];

/**
 * The engine never waits on I/O, so a run of statements would hold the event loop from the first
 * to the last. Giving up the turn after each one lets timers and sockets in between them.
 */
const yieldBetweenStatements: KyselyPlugin = {
  transformQuery: ({ node }) => node,
  transformResult: async ({ result }) => {
    await nextTurn();
    return result;
  },
};

/**
 * How much log may pile up since the last checkpoint before one is made: a segment. The log on
 * disk then stays within a few segments, and a restart after a crash replays at most this much.
 */
const LOG_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * The driver, with a checkpoint once a unit has taken the log past its limit. Kysely gives the
 * connection back when no statement and no transaction is open, which is the only moment the
 * command may run. It holds the thread for the syncs it makes, once in a segment of writes.
 */
class CheckpointingDriver extends PGliteDriver {
  readonly #pglite: PGlite;

  constructor(pglite: PGlite) {
    super({ pglite });
    this.#pglite = pglite;
  }

  override async releaseConnection(): Promise<void> {
    if (this.#pglite.closed) return;
    const { rows } = await this.#pglite.query<{ bytes: number }>(
      "select pg_wal_lsn_diff(pg_current_wal_lsn(), redo_lsn)::float8 as bytes from pg_control_checkpoint()",
    );
    if ((rows[0]?.bytes ?? 0) > LOG_LIMIT_BYTES) await this.#pglite.exec("checkpoint");
  }
}

/** The embedded dialect with the checkpointing driver in place of its own. */
function checkpointing(pglite: PGlite): Dialect {
  const base = new PGliteDialect({ pglite });
  return {
    createAdapter: () => base.createAdapter(),
    createDriver: () => new CheckpointingDriver(pglite),
    createIntrospector: (db) => base.createIntrospector(db),
    createQueryCompiler: () => base.createQueryCompiler(),
  };
}

/**
 * Starts the engine on a directory, or in memory without one, and loads a snapshot into it when
 * one is given. The caller migrates. A directory's commits are synced to disk; memory's are not,
 * and `onSync` is told of each sync.
 */
export async function startEngine(
  directory?: string,
  snapshot?: Blob,
  onSync: () => void = () => undefined,
): Promise<Engine> {
  if (directory !== undefined) await mkdir(directory, { recursive: true });
  const onDisk =
    directory === undefined
      ? {}
      : { dataDir: directory, fs: new SyncedNodeFs(directory, onSync), startParams: DURABLE_START };
  const pglite = await PGlite.create({
    ...onDisk,
    loadDataDir: snapshot,
    postgresqlconf: SETTINGS,
    extensions: { vector, pg_trgm },
    parsers: { [types.INT8]: (value: string) => Number(value) },
  });
  const dialect = directory === undefined ? new PGliteDialect({ pglite }) : checkpointing(pglite);
  const db = connect(dialect, [yieldBetweenStatements]);
  return {
    db,
    snapshot: () => pglite.dumpDataDir("gzip"),
    async close() {
      await db.destroy();
      if (!pglite.closed) await pglite.close();
    },
  };
}

/**
 * Brings a store in a data directory to the newest schema. An existing store that has migrations
 * to take is first kept as the old version left it, so a person can go back.
 */
export async function upgrade(
  engine: Engine,
  dataDir: string,
  migrations: Record<string, Migration> = MIGRATIONS,
): Promise<void> {
  const { applied, pending } = await migrationState(engine.db, migrations);
  if (applied.length > 0 && pending[0] !== undefined)
    await keepUpgradeSnapshot(dataDir, pending[0], await engine.snapshot());
  await migrate(engine.db, migrations);
}

/** Opens the embedded store, creating and migrating it as needed. */
export async function openEmbeddedStore(
  options: EmbeddedStoreOptions = {},
): Promise<EmbeddedStore> {
  const { dataDir } = options;
  const release =
    dataDir === undefined
      ? () => Promise.resolve()
      : await lockDataDir(dataDir, options.lockStaleMs);
  try {
    if (dataDir !== undefined) await settleRestore(dataDir);
    const engineDir = dataDir === undefined ? undefined : join(dataDir, ENGINE_DIR);
    const engine = await (async () => {
      if (engineDir !== undefined) await recoverEngine(engineDir, options.onRecovery);
      return startEngine(engineDir);
    })().catch(async (error: unknown) => {
      if (dataDir === undefined) throw error;
      throw new StoreUnreadableError(dataDir, error, !(await usable(join(dataDir, ENGINE_DIR))));
    });
    try {
      await (dataDir === undefined ? migrate(engine.db) : upgrade(engine, dataDir));
    } catch (error) {
      await engine.close();
      throw error;
    }
    const close = async (): Promise<void> => {
      await engine.close();
      await release();
    };
    return { ...createStore(engine.db, close), snapshot: () => engine.snapshot() };
  } catch (error) {
    await release();
    throw error;
  }
}
