/**
 * The host's own files in the data directory, beside the store: the token a harness sends, the
 * host's own secret, which no harness is given, the record of the running server, the record of a
 * store kept elsewhere, the embedding model and the backups. The directory is the person's alone (0700), and so is every file here that holds a
 * secret (0600).
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TOKEN_ENV } from "@uketsugi/contracts";
import { BACKUPS_DIR } from "@uketsugi/store";
import writeFileAtomic from "write-file-atomic";
import { xdgData } from "xdg-basedir";
import { CliFailure } from "./report.ts";

export interface Home {
  readonly dataDir: string;
  readonly tokenFile: string;
  /**
   * The host's own secret: what `ukt` sends to administer the server it runs (people, tokens, a
   * backup, a sign-in link). It is never printed, and a harness is given the token, never this.
   */
  readonly hostKeyFile: string;
  /** Written by `ukt serve` while it runs: where it listens. */
  readonly recordFile: string;
  /** Written once for a host whose store is on a PostgreSQL server: the database's address. */
  readonly storeFile: string;
  /** The runtime and model: `UKT_MODEL_DIR` when set, which is never written to, else `model/`. */
  readonly modelDir: string;
  readonly modelIsOurs: boolean;
  readonly backupsDir: string;
  /**
   * A token given in the environment (`UKT_TOKEN`). `ukt serve` accepts it; the other verbs use it
   * only where the data directory holds no token of its own.
   */
  readonly givenToken: string | undefined;
}

/** Where a server on this data directory listens. */
export interface ServerRecord {
  readonly url: string;
}

/** Where the store of this data directory's host is, when it is not in the directory itself. */
export interface StoreRecord {
  /** `postgres://user:password@host:port/database`: it holds a password, so the file is the person's alone. */
  readonly databaseUrl: string;
}

/** The data directory: `--data-dir`, else `UKT_DATA_DIR` (commander reads it), else `$XDG_DATA_HOME/uketsugi`. */
export function resolveHome(dataDir: string | undefined, env: NodeJS.ProcessEnv): Home {
  if (dataDir === undefined && xdgData === undefined)
    throw new CliFailure({
      what: "No data directory could be worked out: this account has no home directory.",
      meaning: "There is nowhere to keep the store.",
      next: "Pass --data-dir <dir> or set UKT_DATA_DIR.",
    });
  const dir = resolve(dataDir ?? join(xdgData ?? "", "uketsugi"));
  const given = env["UKT_MODEL_DIR"];
  const external = given !== undefined && given !== "";
  const token = env[TOKEN_ENV];
  return {
    dataDir: dir,
    tokenFile: join(dir, "token"),
    hostKeyFile: join(dir, "host.key"),
    recordFile: join(dir, "server.json"),
    storeFile: join(dir, "store.json"),
    modelDir: external ? resolve(given) : join(dir, "model"),
    modelIsOurs: !external,
    backupsDir: join(dir, BACKUPS_DIR),
    givenToken: token === undefined || token === "" ? undefined : token,
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Writes a private file whole: a reader sees the old text or the new, never half. */
async function writePrivate(path: string, text: string): Promise<void> {
  await writeFileAtomic(path, text, { mode: 0o600 });
}

/** A JSON file's value, or null when the file is missing or is not JSON. */
async function readJson(path: string): Promise<unknown> {
  const text = await readOrNull(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Makes the data directory if it is not there. Returns whether it made it. */
export async function ensureDataDir(home: Home): Promise<boolean> {
  const made = await mkdir(home.dataDir, { recursive: true, mode: 0o700 });
  if (made !== undefined) await chmod(home.dataDir, 0o700);
  return made !== undefined;
}

/** The token the data directory holds, or null when it holds none. */
export async function readTokenFile(home: Home): Promise<string | null> {
  const text = (await readOrNull(home.tokenFile))?.trim();
  return text === undefined || text === "" ? null : text;
}

/** The token to call the server with: the data directory's own, else the one in `UKT_TOKEN`, else null. */
export async function readToken(home: Home): Promise<string | null> {
  return (await readTokenFile(home)) ?? home.givenToken ?? null;
}

export async function writeToken(home: Home, token: string): Promise<void> {
  await writePrivate(home.tokenFile, `${token}\n`);
}

/** The host's own secret, or null when the data directory holds none yet. */
export async function readHostKey(home: Home): Promise<string | null> {
  const text = (await readOrNull(home.hostKeyFile))?.trim();
  return text === undefined || text === "" ? null : text;
}

/** The host's own secret, made the first time it is asked for. The server that runs here is started with it. */
export async function ensureHostKey(home: Home): Promise<string> {
  const held = await readHostKey(home);
  if (held !== null) return held;
  const made = `ukh_${randomBytes(32).toString("hex")}`;
  await writePrivate(home.hostKeyFile, `${made}\n`);
  return made;
}

export async function writeRecord(home: Home, record: ServerRecord): Promise<void> {
  await writePrivate(home.recordFile, `${JSON.stringify(record)}\n`);
}

export async function removeRecord(home: Home): Promise<void> {
  await rm(home.recordFile, { force: true });
}

/** The record of the server on this data directory, or null when none was left or it is unreadable. */
export async function readRecord(home: Home): Promise<ServerRecord | null> {
  const record = (await readJson(home.recordFile)) as Partial<ServerRecord> | null;
  return typeof record?.url === "string" ? { url: record.url } : null;
}

export async function writeStoreRecord(home: Home, record: StoreRecord): Promise<void> {
  await writePrivate(home.storeFile, `${JSON.stringify(record)}\n`);
}

/** The record of a store kept on a PostgreSQL server, or null for a host that has none. */
export async function readStoreRecord(home: Home): Promise<StoreRecord | null> {
  const record = (await readJson(home.storeFile)) as Partial<StoreRecord> | null;
  return typeof record?.databaseUrl === "string" ? { databaseUrl: record.databaseUrl } : null;
}

/** A path that others on this machine can reach, with the mode it must be tightened to. */
export interface LooseMode {
  readonly path: string;
  readonly mode: string;
  readonly allowed: string;
}

/** The data directory and the files that hold a secret, where they are open to anyone but their owner. */
export async function looseModes(home: Home): Promise<LooseMode[]> {
  const loose: LooseMode[] = [];
  for (const [path, allowed] of [
    [home.dataDir, 0o700],
    [home.tokenFile, 0o600],
    [home.hostKeyFile, 0o600],
    [home.storeFile, 0o600],
  ] as const) {
    const mode = await stat(path).then(
      (stats) => stats.mode & 0o777,
      () => null,
    );
    if (mode !== null && (mode & ~allowed) !== 0)
      loose.push({ path, mode: mode.toString(8), allowed: allowed.toString(8) });
  }
  return loose;
}
