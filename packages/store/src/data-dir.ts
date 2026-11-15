/**
 * The data directory of an embedded store: what lies in it, and the lock that gives it one owner.
 * The engine does not guard its directory (two processes on one lose writes silently), so every
 * opener, the restore included, takes this lock first.
 *
 * The lock is `proper-lockfile`'s: a directory whose modification time its holder refreshes every
 * second. A holder that dies stops refreshing, and the lock is taken over once it is `staleMs` old.
 * A holder that finds its lock taken over throws from a timer, which ends the process: it must not
 * write beside the new owner.
 */
import { constants, existsSync } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";

/** The engine's own directory, under the data directory. */
export const ENGINE_DIR = "pg";
/** The engine directory a restore has loaded and not yet swapped in. */
export const INCOMING_DIR = "pg.restoring";
/** The engine directory a restore has swapped out and not yet removed. */
export const OUTGOING_DIR = "pg.replaced";

/** Where snapshots are kept, under the data directory. */
export const BACKUPS_DIR = "backups";

/** A snapshot kept before an upgrade, named after the first migration the upgrade applied. */
const UPGRADE_SNAPSHOT = /^before-\d{4}_\w+\.tgz$/;
/** How many of them are kept: the newest, by the order of their migrations. */
const UPGRADE_SNAPSHOTS_KEPT = 3;

/** A lock nobody has refreshed for this long belongs to a dead process. */
const LOCK_STALE_MS = 10_000;

/**
 * A lock whose note names this process's own pid was left by an earlier process with that pid: a
 * restarted container is process 1 again. The pid proves nothing either way (a second container
 * on the same volume can also be process 1, alive), so the heartbeat alone decides, and quickly:
 * a living holder refreshes every second, and three seconds without a refresh is a dead one.
 */
const OWN_PID_STALE_MS = 3000;

const REFRESH_EVERY_MS = 1000;
const RETRY_EVERY_MS = 200;

/**
 * How far ahead of the clock the lock's time can be. The lock library stamps the first lock a
 * process takes with the next whole second plus 5 ms, to learn how finely the file system keeps
 * time, and the stamp stays until the first refresh. A holder killed in its first second leaves
 * such a lock, which goes stale this much later than its stale time, so a taker waits this much
 * longer for it.
 */
const STAMP_AHEAD_MS = 1005;

/**
 * Thrown to an opener of a store another process holds: a data directory or a database has one
 * owner. The message says who holds it and what to do.
 */
export class StoreInUseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreInUseError";
  }
}

/**
 * Thrown when the engine cannot start on a data directory's files. The engine throws things that
 * are not errors (an `ErrnoError` is a plain object), so the cause is put in words here: that the
 * files cannot be read and written by this user, which is the common one, else what it said.
 */
export class StoreUnreadableError extends Error {
  /** Whether the files could not be read and written by this user. */
  readonly permission: boolean;
  constructor(directory: string, cause: unknown, permission: boolean) {
    const said =
      cause instanceof Error
        ? cause.message
        : typeof cause === "object" && cause !== null && "name" in cause
          ? `${String(cause.name)}${"errno" in cause ? ` ${String(cause.errno)}` : ""}`
          : String(cause);
    super(
      permission
        ? `The store in ${directory} cannot be read and written by this user.`
        : `The store in ${directory} could not be opened: ${said}.`,
      { cause },
    );
    this.name = "StoreUnreadableError";
    this.permission = permission;
  }
}

/** Whether this user may read, write and enter the directory; true where it is not there yet. */
export async function usable(directory: string): Promise<boolean> {
  const code = await access(directory, constants.R_OK | constants.W_OK | constants.X_OK).then(
    () => null,
    (error: NodeJS.ErrnoException) => error.code,
  );
  return code !== "EACCES" && code !== "EPERM";
}

/** Whether a data directory holds an embedded store: its engine's directory is there. */
export function holdsEmbeddedStore(dataDir: string): boolean {
  return existsSync(join(dataDir, ENGINE_DIR)) || existsSync(join(dataDir, OUTGOING_DIR));
}

/** The directories this process holds, by real path. */
const held = new Set<string>();

interface Owner {
  readonly pid: number;
  readonly host: string;
}

function isLocked(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ELOCKED";
}

/** The process that last took the lock, as it wrote itself down; null when the note is unreadable. */
async function ownerOf(dataDir: string): Promise<Owner | null> {
  try {
    const note = JSON.parse(await readFile(join(dataDir, "lock.owner"), "utf8")) as Partial<Owner>;
    return typeof note.pid === "number" && typeof note.host === "string"
      ? { pid: note.pid, host: note.host }
      : null;
  } catch {
    return null;
  }
}

function isThisPid(owner: Owner | null): boolean {
  return owner !== null && owner.host === hostname() && owner.pid === process.pid;
}

/** Whether the owner is another process this machine can see running. Another host's is not. */
function isRunningHere(owner: Owner | null): boolean {
  if (owner === null || owner.host !== hostname() || owner.pid === process.pid) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists and belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function refusal(
  dataDir: string,
  owner: Owner | null,
  staleMs: number,
  cause: unknown,
): StoreInUseError {
  const where = owner?.host === hostname() ? "this machine" : (owner?.host ?? "");
  const who = owner === null ? "its lock names no process" : `process ${owner.pid} on ${where}`;
  const seconds = Math.ceil((staleMs + STAMP_AHEAD_MS) / 1000);
  return new StoreInUseError(
    `The data directory ${dataDir} is in use by another uketsugi process (${who}). ` +
      `Stop that process, or give this one its own directory with --data-dir or UKT_DATA_DIR. ` +
      `If that process is gone, its lock expires ${seconds} seconds after it stopped: try again then.`,
    { cause },
  );
}

/**
 * Takes the data directory for this process and returns the function that gives it back. A second
 * taker is refused at once while this process holds the directory or its owner is seen running on
 * this machine. Otherwise the lock's heartbeat decides: the taker waits for it to go stale, so a
 * lock left by a killed process is recovered without anyone removing a file.
 */
export async function lockDataDir(
  dataDir: string,
  staleMs: number = LOCK_STALE_MS,
): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true });
  const key = await realpath(dataDir);
  const options = {
    lockfilePath: join(dataDir, "lock"),
    stale: staleMs,
    update: REFRESH_EVERY_MS,
    onCompromised: (error: Error) => {
      throw new Error(
        `uketsugi lost its lock on ${dataDir}: another process took the directory. ` +
          `This process stops so that two never write to one store.`,
        { cause: error },
      );
    },
  };
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(dataDir, options);
  } catch (error) {
    const owner = await ownerOf(dataDir);
    if (!isLocked(error) || held.has(key) || isRunningHere(owner))
      throw refusal(dataDir, owner, staleMs, error);
    const stale = isThisPid(owner) ? Math.min(staleMs, OWN_PID_STALE_MS) : staleMs;
    const retries = Math.ceil((stale + STAMP_AHEAD_MS) / RETRY_EVERY_MS) + 2;
    const patient = { retries, factor: 1, minTimeout: RETRY_EVERY_MS, maxTimeout: RETRY_EVERY_MS };
    const waiting = lockfile.lock(dataDir, { ...options, stale, retries: patient });
    release = await waiting.catch((again: unknown) => {
      throw refusal(dataDir, owner, stale, again);
    });
  }
  held.add(key);
  const giveBack = async (): Promise<void> => {
    held.delete(key);
    await release();
  };
  const note = JSON.stringify({ pid: process.pid, host: hostname() });
  await writeFile(join(dataDir, "lock.owner"), note).catch(async (error: unknown) => {
    await giveBack();
    throw error;
  });
  return giveBack;
}

/**
 * Puts the engine directory right after a restore that was cut short. The restore swaps by two
 * renames; cut between them, the store that was being replaced is the one that is whole, and it
 * goes back. Leftovers of a finished or an unfinished restore are removed. Call with the lock held.
 */
export async function settleRestore(dataDir: string): Promise<void> {
  const [engine, outgoing] = [join(dataDir, ENGINE_DIR), join(dataDir, OUTGOING_DIR)];
  if (!existsSync(engine) && existsSync(outgoing)) await rename(outgoing, engine);
  await rm(outgoing, { recursive: true, force: true });
  await rm(join(dataDir, INCOMING_DIR), { recursive: true, force: true });
}

/**
 * Writes a snapshot so that its file is whole or absent: a temporary name, synced, then renamed.
 * A snapshot holds every person's text, so wherever it is written it is its owner's alone to read.
 */
export async function writeSnapshot(file: string, snapshot: Blob): Promise<number> {
  await mkdir(dirname(file), { recursive: true });
  const bytes = Buffer.from(await snapshot.arrayBuffer());
  await writeFileAtomic(file, bytes, { mode: 0o600 });
  return bytes.byteLength;
}

/**
 * Keeps the store as it was before it took `migration`, beside the snapshots of earlier upgrades,
 * of which only the newest stay.
 */
export async function keepUpgradeSnapshot(
  dataDir: string,
  migration: string,
  snapshot: Blob,
): Promise<void> {
  const backups = join(dataDir, BACKUPS_DIR);
  await writeSnapshot(join(backups, `before-${migration}.tgz`), snapshot);
  const kept = (await readdir(backups)).filter((name) => UPGRADE_SNAPSHOT.test(name)).sort();
  for (const name of kept.slice(0, -UPGRADE_SNAPSHOTS_KEPT)) await rm(join(backups, name));
}
