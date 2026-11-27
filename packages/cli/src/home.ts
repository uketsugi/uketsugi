/**
 * The host's own files in the data directory, beside the store: the token a harness sends, the
 * host's own secret, which no harness is given, the record of the running server, how the server
 * is set to run, the language model the host was given with its key, the embedding model and the
 * backups. The directory is the person's alone (0700), and so is every file here that holds a
 * secret (0600).
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TOKEN_ENV } from "@uketsugi/contracts";
import { isMissing } from "@uketsugi/embed";
import { BACKUPS_DIR } from "@uketsugi/store";
import writeFileAtomic from "write-file-atomic";
import { xdgData } from "xdg-basedir";
import { CliFailure } from "./report.ts";
import { SERVING, SERVING_KEYS, type ServingKey, type Serving } from "./settings.ts";

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
  /** Why the last start of the server failed, written by `ukt serve` and gone once a start succeeds. */
  readonly startFailureFile: string;
  /** What the last upgrade did, written by `ukt upgrade`: see `upgrade-record.ts`. */
  readonly upgradeFile: string;
  /** How the server is set to run: what `ukt setup` was told, and where the store is when it is elsewhere. */
  readonly settingsFile: string;
  /** Written by `ukt setup --llm`: the language model the host was given, with its provider's key. */
  readonly llmFile: string;
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

/**
 * Where a server on this data directory listens. Its process is named too, for a store that has no
 * lock to name it (on a PostgreSQL server): a verb tells a server that is busy from one that is
 * gone by it. A record left by an early release has none, and an embedded store's lock answers.
 */
export interface ServerRecord {
  readonly url: string;
  readonly pid?: number;
  readonly host?: string;
}

/**
 * How this host's server runs, as far as its person has said: what `ukt setup` was told, kept so
 * that every later start is the same server whoever starts it. A service manager starts it with
 * no flags and no shell, so nothing a person chose may live only in a command they typed. A key
 * is here once it was given; one that is not falls back to what is built in.
 */
export type Settings = Serving & {
  /**
   * Where the store is when it is not in the data directory itself:
   * `postgres://user:password@host:port/database`. It holds a password, so the file is the
   * person's alone. A host's store is named once, for good (`host-store.ts`).
   */
  readonly databaseUrl?: string;
};

/** Where 0.1.0 recorded the address of a store on a PostgreSQL server: read still, never written. */
const STORE_FILE_OF_0_1_0 = "store.json";

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
    startFailureFile: join(dir, "last-start-failure"),
    upgradeFile: join(dir, "upgrade.json"),
    settingsFile: join(dir, "settings.json"),
    llmFile: join(dir, "llm.json"),
    modelDir: external ? resolve(given) : join(dir, "model"),
    modelIsOurs: !external,
    backupsDir: join(dir, BACKUPS_DIR),
    givenToken: token === undefined || token === "" ? undefined : token,
  };
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

/** The value a file of settings holds, or null when it is not an object of JSON. */
function settingsOf(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The settings one file holds; none where the file is missing. A file that is there and cannot be
 * read as settings is refused: taken for "nothing was said", a host whose store is on a PostgreSQL
 * server would be started on a new, empty store in its data directory.
 */
async function settingsIn(path: string): Promise<Settings> {
  const text = await readOrNull(path);
  if (text === null) return {};
  const kept = settingsOf(text);
  if (kept === null)
    throw new CliFailure({
      what: `${path} cannot be read: it does not hold the settings \`ukt setup\` wrote.`,
      meaning: "It says how this host's server runs and where its store is, so nothing was done.",
      next: "Put the file back from a copy, or move it away and run `ukt setup` again with the options this host was set up with.",
    });
  const read = (key: ServingKey): [ServingKey, unknown][] => {
    const value = kept[key];
    switch (SERVING[key].kind) {
      case "text":
        return typeof value === "string" ? [[key, value]] : [];
      case "names":
        return Array.isArray(value)
          ? [[key, value.filter((name): name is string => typeof name === "string")]]
          : [];
      case "flag":
        return value === true ? [[key, true]] : [];
    }
  };
  return {
    ...(typeof kept.databaseUrl === "string" ? { databaseUrl: kept.databaseUrl } : {}),
    ...Object.fromEntries(SERVING_KEYS.flatMap(read)),
  };
}

/** How the server on this data directory is set to run: every key that was ever given. */
export async function readSettings(home: Home): Promise<Settings> {
  const kept = await settingsIn(home.settingsFile);
  if (kept.databaseUrl !== undefined) return kept;
  const { databaseUrl } = await settingsIn(join(home.dataDir, STORE_FILE_OF_0_1_0));
  return { ...kept, databaseUrl };
}

/** Settings as one line of JSON, their keys in one order: how they are written and compared. */
function written(settings: Settings): string {
  return JSON.stringify(
    Object.fromEntries(
      ["databaseUrl", ...SERVING_KEYS].map((key) => [key, settings[key as keyof Settings]]),
    ),
  );
}

/** What would be kept with `given` added, a key left out staying as it was, and whether that changes how the server is set to run. */
export async function settingsWith(
  home: Home,
  given: Settings,
): Promise<{ readonly next: Settings; readonly changed: boolean }> {
  const kept = await readSettings(home);
  const told = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined));
  const next: Settings = { ...kept, ...told };
  return { next, changed: written(next) !== written(kept) };
}

/** Keeps what it is given beside what is kept already. Returns whether that changed how the server is set to run. */
export async function keepSettings(home: Home, given: Settings): Promise<boolean> {
  const { next, changed } = await settingsWith(home, given);
  // What 0.1.0 recorded in a file of its own moves here with the first thing kept.
  if (written(next) !== written(await settingsIn(home.settingsFile))) {
    await writePrivate(home.settingsFile, `${written(next)}\n`);
    await rm(join(home.dataDir, STORE_FILE_OF_0_1_0), { force: true });
  }
  return changed;
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

/** The most bytes of a start's failure that are kept. */
const START_FAILURE_BYTES = 2000;

/** Replaces what is kept of why the last start failed. A start that failed before the data directory existed makes it: the reason is kept all the same. */
export async function keepStartFailure(home: Home, text: string): Promise<void> {
  await ensureDataDir(home);
  const kept = Buffer.from(text).subarray(0, START_FAILURE_BYTES).toString();
  await writePrivate(home.startFailureFile, `${kept}\n`);
}

/** Why the last start failed and when, or null where it did not, or a start has succeeded since. */
export async function readStartFailure(home: Home): Promise<{ text: string; at: Date } | null> {
  const text = (await readOrNull(home.startFailureFile))?.trim();
  if (text === undefined || text === "") return null;
  return { text, at: (await stat(home.startFailureFile)).mtime };
}

export async function removeStartFailure(home: Home): Promise<void> {
  await rm(home.startFailureFile, { force: true });
}

/** The record of the server on this data directory, or null when none was left or it is unreadable. */
export async function readRecord(home: Home): Promise<ServerRecord | null> {
  const record = (await readJson(home.recordFile)) as Partial<ServerRecord> | null;
  if (typeof record?.url !== "string") return null;
  const { url, pid, host } = record;
  return typeof pid === "number" && typeof host === "string" ? { url, pid, host } : { url };
}

/**
 * What the last upgrade did, kept so that `ukt rollback` and `ukt doctor` can say it. A release that
 * started is kept with the release before it (`previous`) and the copy of the store that the
 * migration made before it changed anything (`snapshot`, null where no migration ran); one that
 * did not start was put back, and says why.
 */
export interface UpgradeRecord {
  readonly from: string;
  readonly to: string;
  /** ISO 8601, UTC. */
  readonly at: string;
  readonly previous: string | null;
  readonly snapshot: string | null;
  /** Set where the new release's server did not start and the release before it was put back. */
  readonly failed?: string;
}

export async function writeUpgrade(home: Home, record: UpgradeRecord): Promise<void> {
  await mkdir(home.dataDir, { recursive: true, mode: 0o700 });
  await writePrivate(home.upgradeFile, `${JSON.stringify(record)}\n`);
}

export async function removeUpgrade(home: Home): Promise<void> {
  await rm(home.upgradeFile, { force: true });
}

/** The last upgrade's record, or null where there is none or it is unreadable. */
export async function readUpgrade(home: Home): Promise<UpgradeRecord | null> {
  const kept = (await readJson(home.upgradeFile)) as Partial<UpgradeRecord> | null;
  if (typeof kept?.from !== "string" || typeof kept.to !== "string" || typeof kept.at !== "string")
    return null;
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    from: kept.from,
    to: kept.to,
    at: kept.at,
    previous: text(kept.previous),
    snapshot: text(kept.snapshot),
    ...(typeof kept.failed === "string" ? { failed: kept.failed } : {}),
  };
}

/** The language model a host was given: `provider/model`, its provider's key, and its address where it has one of its own. */
export interface LlmRecord {
  readonly model: string;
  /** The provider's key: it is why the file is the person's alone. */
  readonly key: string;
  readonly url?: string;
  /** The most tokens the server may spend on the model in a day, where the person set one. */
  readonly budget?: number;
}

export async function writeLlmRecord(home: Home, record: LlmRecord): Promise<void> {
  await writePrivate(home.llmFile, `${JSON.stringify(record)}\n`);
}

export async function removeLlmRecord(home: Home): Promise<void> {
  await rm(home.llmFile, { force: true });
}

/** The record of the language model this host was given, or null where it was given none. */
export async function readLlmRecord(home: Home): Promise<LlmRecord | null> {
  const record = (await readJson(home.llmFile)) as Partial<LlmRecord> | null;
  if (typeof record?.model !== "string" || typeof record.key !== "string") return null;
  const url = typeof record.url === "string" ? { url: record.url } : {};
  const budget = typeof record.budget === "number" ? { budget: record.budget } : {};
  return { model: record.model, key: record.key, ...url, ...budget };
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
    [home.settingsFile, 0o600],
    [home.llmFile, 0o600],
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

/** Tightens what `looseModes` finds to the mode it names, and returns what it found. */
export async function tightenModes(home: Home): Promise<LooseMode[]> {
  const loose = await looseModes(home);
  for (const { path, allowed } of loose) await chmod(path, Number.parseInt(allowed, 8));
  return loose;
}
