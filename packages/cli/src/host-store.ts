/**
 * Where a host keeps its store. A data directory names one store, for good: its own engine's, or
 * a database on a PostgreSQL server, whose address is kept with the host's settings the first
 * time a verb opens it. Every verb that reaches the store asks here first. So a verb that is not told the
 * database again still uses it, and a verb told of another store is refused before it can make a
 * second, empty one beside the first.
 */
import { openLocalPorts, type LocalPorts } from "@uketsugi/server";
import {
  holdsEmbeddedStore,
  serverStoreName,
  StoreInUseError,
  StoreUnreadableError,
  StoreUnavailableError,
} from "@uketsugi/store";
import { keepSettings, readSettings, resolveHome, type Home } from "./home.ts";
import { CliFailure, describe } from "./report.ts";

/** A host's store: where it is, and whether the data directory holds or names it yet. */
export type HostStore =
  | { readonly kind: "embedded"; readonly made: boolean }
  | {
      readonly kind: "postgres";
      readonly made: boolean;
      /** The address to connect with: the one given now when there is one, since its credentials are the newer. */
      readonly databaseUrl: string;
      /** The database as `host:port/database`, without its credentials. */
      readonly name: string;
    };

const NOTHING_DONE = "Nothing was started or changed.";
const OWN_DIRECTORY = "needs a data directory of its own: pass --data-dir or set UKT_DATA_DIR.";
const LEAVE_OUT = "Leave --database-url out, and UKT_DATABASE_URL unset,";

/** The database a given address names; an address that is not a PostgreSQL URL is refused, and never echoed. */
function nameOf(given: string): string {
  if (/^postgres(?:ql)?:\/\//.test(given)) return serverStoreName(given);
  throw new CliFailure({
    what: "The database address (--database-url or UKT_DATABASE_URL) is not a PostgreSQL URL.",
    meaning: NOTHING_DONE,
    next: "Pass it as postgres://user:password@host:port/database.",
  });
}

/**
 * The store of the host a data directory belongs to. `given` is `--database-url` or
 * `UKT_DATABASE_URL`: it may say again where the host's store is, and may not name another.
 */
export async function hostStore(home: Home, given: string | undefined): Promise<HostStore> {
  const asked = given === undefined || given.trim() === "" ? null : nameOf(given.trim());
  const recorded = (await readSettings(home)).databaseUrl;
  if (recorded !== undefined) {
    const name = serverStoreName(recorded);
    if (asked !== null && asked !== name)
      throw new CliFailure({
        what: `This host's store is the PostgreSQL database ${name} (recorded in ${home.dataDir}), and the address given names another: ${asked}.`,
        meaning: `A host has one store. ${NOTHING_DONE}`,
        next: `${LEAVE_OUT} to use ${name}. A host on ${asked} ${OWN_DIRECTORY}`,
      });
    const databaseUrl = asked === null ? recorded : (given ?? "").trim();
    return { kind: "postgres", made: true, databaseUrl, name };
  }
  const made = holdsEmbeddedStore(home.dataDir);
  if (asked === null) return { kind: "embedded", made };
  if (made)
    throw new CliFailure({
      what: `The data directory ${home.dataDir} holds this host's store, and the address given names another: the PostgreSQL database ${asked}.`,
      meaning: `Going on would start a second, empty store beside the first. ${NOTHING_DONE}`,
      next: `${LEAVE_OUT} to use the store in the data directory. A host on ${asked} ${OWN_DIRECTORY}`,
    });
  return { kind: "postgres", made: false, databaseUrl: (given ?? "").trim(), name: asked };
}

/** What names a verb's host and its store: `--data-dir` and `--database-url`. */
type HostOptions = { readonly dataDir?: string; readonly databaseUrl?: string };

/** A verb's host and its store. */
export type Host = { readonly home: Home; readonly store: HostStore };

/** The host a verb is run for, by `--data-dir` and `--database-url` or their variables, and its store. */
export async function hostOf(options: HostOptions, env: NodeJS.ProcessEnv): Promise<Host> {
  const home = resolveHome(options.dataDir, env);
  return { home, store: await hostStore(home, options.databaseUrl) };
}

/** What `openLocalPorts` and `startLocalServer` take to open this host's store. */
export function storeOptions(home: Home, store: HostStore) {
  return {
    dataDir: home.dataDir,
    databaseUrl: store.kind === "postgres" ? store.databaseUrl : undefined,
  };
}

/** Records where the host's store is, once a verb has opened it: a database's address, as last given. */
export async function rememberStore(home: Home, store: HostStore): Promise<void> {
  if (store.kind === "postgres") await keepSettings(home, { databaseUrl: store.databaseUrl });
}

/** Where the store is, in words that never show a database's password. */
export function storePlace(home: Home, store: HostStore): string {
  return store.kind === "postgres" ? `PostgreSQL at ${store.name}` : home.dataDir;
}

/**
 * The failure of a store that could not be opened, in the three parts, or null when the error is
 * not about that: another process holds it, or its database could not be reached.
 */
export function storeFailure(error: unknown, meaning: string): CliFailure | null {
  const failed = (next: string): CliFailure =>
    new CliFailure({ what: describe(error), meaning, next });
  if (error instanceof StoreInUseError)
    return failed("Use the server that is running, or stop it, then run this again.");
  if (error instanceof StoreUnreadableError)
    return failed(
      error.permission
        ? "Run the command as the user who owns that folder, or give this user read and write access to it (for instance `chown -R $USER` on the data directory), then run this again."
        : "If the folder was copied or damaged, restore a snapshot with `ukt restore <file>`; if it is not a store, point --data-dir at another folder.",
    );
  // A database that answered says what it lacks; one that did not is looked for.
  if (error instanceof StoreUnavailableError)
    return failed(
      error.remedy ??
        "Check that the PostgreSQL server is running and that the address (--database-url or UKT_DATABASE_URL) is right, then run this again.",
    );
  return null;
}

/**
 * Opens the host's store for one piece of work and closes it. A host that had no store has one
 * afterwards, and the directory says where. A store that cannot be opened fails in the three parts.
 */
export async function withStore<T>(
  home: Home,
  store: HostStore,
  work: (local: LocalPorts) => Promise<T>,
): Promise<T> {
  const local = await openLocalPorts(storeOptions(home, store)).catch((error: unknown) => {
    throw storeFailure(error, "Nothing was changed.") ?? error;
  });
  try {
    await rememberStore(home, store);
    return await work(local);
  } finally {
    await local.close();
  }
}

/** Refuses a verb that needs the host's store when the data directory holds and names none. */
export function requireStore(home: Home, store: HostStore, verb: string): void {
  if (store.made) return;
  throw new CliFailure({
    what: `The data directory ${home.dataDir} holds no store yet.`,
    meaning: `\`ukt ${verb}\` works on a host's store and would have made an empty one, so it did nothing.`,
    next: "Check --data-dir or UKT_DATA_DIR. To set this host up, run `ukt setup`.",
  });
}

/**
 * The host of a verb that copies the files of the store in the data directory, and that store; a
 * host that keeps its store elsewhere is refused.
 */
export async function embeddedHostOf(
  options: HostOptions,
  env: NodeJS.ProcessEnv,
  verb: string,
): Promise<Host> {
  const { home, store } = await hostOf(options, env);
  if (store.kind === "embedded") return { home, store };
  throw new CliFailure({
    what: `This host's store is the PostgreSQL database ${store.name}.`,
    meaning: `\`ukt ${verb}\` copies the files of a store kept in the data directory, so it did nothing.`,
    next: "Back the database up and restore it with PostgreSQL's own tools, for example pg_dump and pg_restore.",
  });
}
