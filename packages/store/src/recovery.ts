/**
 * Crash recovery of the engine's directory, off the main thread. A store that was not shut down
 * cleanly is recovered by the engine's own start: it syncs every file in the directory (twice a
 * file), replays the log and checkpoints, and each sync holds the thread for as long as the disk
 * takes, which is minutes where the files are dirty. On the main thread that is a server that does
 * not answer and does not stop. Here the start and the clean close that follows it run in a worker
 * thread, which tells this thread each sync it makes, and the clean start that comes after is the
 * three syncs of any other.
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

/** Where a recovery is: the sync walk the engine's start opens with, the replay and checkpoint after it, and the clean close. */
export type RecoveryPhase = "syncing" | "replaying" | "closing" | "done";

export interface RecoveryProgress {
  readonly phase: RecoveryPhase;
  /** The syncs made so far. */
  readonly synced: number;
  /** The syncs the walk is expected to make; only in the phase it covers, null in the others. */
  readonly of: number | null;
}

/** What the worker tells this thread. */
export type WorkerMessage =
  { readonly kind: "synced"; readonly count: number } | { readonly kind: "closing" };

/** The recovery as a person reads it. */
export function describeRecovery({ phase, synced, of }: RecoveryProgress): string {
  switch (phase) {
    case "syncing":
      return `syncing the store's files: ${synced} of about ${of ?? synced}`;
    case "replaying":
      return `replaying what was written since the last clean stop (${synced} syncs so far)`;
    case "closing":
      return `closing the store cleanly (${synced} syncs so far)`;
    case "done":
      return `done (${synced} syncs)`;
  }
}

/** Byte 16 of the engine's control file is its state; 1 is a clean shutdown. */
const STATE_AT = 16;
const SHUT_DOWN_CLEANLY = 1;

/** Whether the engine was left without a clean shutdown. A directory with no control file is new. */
async function leftUnclean(engineDir: string): Promise<boolean> {
  const control = await readFile(join(engineDir, "global", "pg_control")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  return control !== null && control.readUInt32LE(STATE_AT) !== SHUT_DOWN_CLEANLY;
}

/** The syncs the engine's start makes walking the directory: two a file and one a directory. */
async function expectedSyncs(engineDir: string): Promise<number> {
  const entries = await readdir(engineDir, { recursive: true, withFileTypes: true });
  return 1 + entries.reduce((sum, entry) => sum + (entry.isDirectory() ? 1 : 2), 0);
}

/** The worker's module: a `.ts` beside this one where the workspace runs from source, a `.js` in a build. */
const workerEntry = (): URL =>
  new URL(`./recover-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);

/**
 * Recovers the engine's directory if it was not shut down cleanly, telling `onProgress` where it
 * is: once before the first sync, after each, and when it is done. Resolves when the directory is
 * shut down cleanly; rejects with what the engine said when it cannot be recovered. A directory
 * shut down cleanly starts no thread. Call with the data directory's lock held.
 */
export async function recoverEngine(
  engineDir: string,
  onProgress: (progress: RecoveryProgress) => void = () => undefined,
): Promise<void> {
  if (!(await leftUnclean(engineDir))) return;
  const of = await expectedSyncs(engineDir);
  let synced = 0;
  let closing = false;
  const tell = (): void =>
    onProgress({
      phase: closing ? "closing" : synced < of ? "syncing" : "replaying",
      synced,
      of: !closing && synced < of ? of : null,
    });
  tell();
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(workerEntry(), { workerData: { engineDir } });
    worker.on("message", (message: WorkerMessage) => {
      if (message.kind === "synced") synced = message.count;
      else closing = true;
      tell();
    });
    worker.once("error", reject);
    worker.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`the recovery ended with code ${code}`)),
    );
  });
  onProgress({ phase: "done", synced, of: null });
}
