/**
 * The verbs that copy the data directory's own store: `backup` writes a snapshot, through the
 * running server when there is one, and `restore` replaces the store with a snapshot, which needs
 * the data directory to itself. A host whose store is on a PostgreSQL server has neither.
 */
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  backupEmbeddedStore,
  openEmbeddedStore,
  restoreEmbeddedStore,
  writeSnapshot,
} from "@uketsugi/store";
import type { Home } from "./home.ts";
import { embeddedHostOf, requireStore, storeFailure } from "./host-store.ts";
import { dirFlag, onStore, type OnStore, type Program } from "./program.ts";
import { CliFailure, confirmPlan, describe, size, type Io, type Report } from "./report.ts";
import { connectAsHost, servingNow, snapshot } from "./server-client.ts";
import { pauseFor } from "./service.ts";

/** The UTC time to the second, as a file name carries it: `20261113T152233Z`. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]|\.\d+/g, "");
}

/** Opens the store nobody is serving, writes a snapshot of it to `file` and closes it. Returns the snapshot's size. */
async function snapshotTo(home: Home, file: string): Promise<number> {
  const store = await openEmbeddedStore({ dataDir: home.dataDir }).catch((error: unknown) => {
    throw storeFailure(error, "No snapshot was written.") ?? error;
  });
  try {
    return await backupEmbeddedStore(store, file);
  } finally {
    await store.close();
  }
}

export interface BackupOptions extends OnStore {
  readonly dataDir?: string;
  /** The file to write; `backups/uketsugi-<time>.tgz` in the data directory when left out. */
  readonly out?: string;
  readonly json?: boolean;
}

/** `ukt backup`: the whole store, vectors included, as one file. A running server takes the snapshot itself and goes on serving. */
export async function backup(options: BackupOptions, env: NodeJS.ProcessEnv): Promise<Report> {
  const { home, store } = await embeddedHostOf(options, env, "backup");
  requireStore(home, store, "backup");
  const file = resolve(options.out ?? join(home.backupsDir, `uketsugi-${stamp(new Date())}.tgz`));
  const serving = (await servingNow(home)) !== null;
  const bytes = serving
    ? await writeSnapshot(file, await snapshot(await connectAsHost(home)))
    : await snapshotTo(home, file);
  return {
    data: { file, bytes, while_serving: serving },
    lines: [`${file} (${size(bytes)})`, `Restore it with: ukt restore ${file}`],
  };
}

export interface RestoreOptions extends OnStore {
  readonly dataDir?: string;
  /** With `--discard-current`: the store as it is now is replaced without a copy of it being kept. */
  readonly discardCurrent?: boolean;
  readonly yes?: boolean;
  readonly json?: boolean;
}

/** `ukt restore <snapshot>`: replaces the store with a snapshot, after showing the plan and asking. */
export async function restore(
  io: Io,
  snapshotFile: string,
  options: RestoreOptions,
  env: NodeJS.ProcessEnv,
): Promise<Report> {
  const { home, store } = await embeddedHostOf(options, env, "restore");
  const file = resolve(snapshotFile);
  const found = await stat(file).catch(() => null);
  if (found === null || !found.isFile())
    throw new CliFailure({
      what: `There is no snapshot file at ${file}.`,
      meaning: "Nothing was changed.",
      next: `Name a file \`ukt backup\` wrote; they are kept in ${home.backupsDir} unless you chose elsewhere.`,
    });
  const pause = await pauseFor(io, env, home, "restore");
  // A data directory with no store yet has nothing to keep a copy of.
  const keep = store.made && options.discardCurrent !== true;
  const kept = join(home.backupsDir, `before-restore-${stamp(new Date())}.tgz`);
  await confirmPlan(
    io,
    [
      `This replaces the whole store in ${home.dataDir}`,
      `with the snapshot ${file} (${size(found.size)}, written ${found.mtime.toISOString()}).`,
      "Everything stored after that snapshot was taken is lost.",
      "People, their tokens and their choices go back to what they were then: a token revoked since works again, and a project made private since is shared again.",
      keep
        ? `The store as it is now is first saved to ${kept}.`
        : "No copy of the store as it is now is kept.",
      ...(pause === null ? [] : [pause.line]),
    ],
    options,
  );
  const replace = async (): Promise<void> => {
    if (keep) {
      await snapshotTo(home, kept).catch((error: unknown) => {
        throw new CliFailure({
          what: `The store as it is now could not be saved first: ${describe(error)}`,
          meaning: "Nothing was replaced.",
          next: "To replace it without keeping a copy, run the command again with --discard-current.",
        });
      });
    }
    await restoreEmbeddedStore({ dataDir: home.dataDir, file });
  };
  await (pause === null ? replace() : pause.around(replace));
  return {
    data: { restored: file, data_dir: home.dataDir, kept: keep ? kept : null },
    lines: [
      `Restored ${file} into ${home.dataDir}.`,
      ...(keep ? [`The store as it was is kept at ${kept}.`] : []),
      pause === null
        ? `Start the server again with: ukt serve${dirFlag(options)}`
        : "The service is running again, on the restored store.",
    ],
  };
}

/** Adds `backup` and `restore` to the program. */
export function storeVerbs({ io, env, verb, run }: Program): void {
  onStore(verb("backup", "write a snapshot of the whole store to one file"))
    .option("--out <file>", "the file to write; the data directory's backups/ when left out")
    .action((options: BackupOptions) => run("backup", options, () => backup(options, env)));
  onStore(verb("restore", "replace the store with a snapshot"))
    .argument("<snapshot>", "a file `ukt backup` wrote")
    .option("--yes", "do not ask before replacing")
    .option("--discard-current", "do not keep a copy of the store as it is now")
    .action((snapshotFile: string, options: RestoreOptions) =>
      run("restore", options, () => restore(io, snapshotFile, options, env)),
    );
}
