/**
 * The store on a PostgreSQL server, through `pg`: the deployment for more than one person. The
 * statements and the migrations are the ones the embedded engine runs; this file opens the pool
 * and gives the database one owner. The server needs pgvector 0.7 or newer (`halfvec`) and
 * `pg_trgm`.
 *
 * One process holds a database at a time, as one holds a data directory: sessions are inferred
 * and browsers signed in per process, so two servers on one database would each open sessions and
 * refuse the other's sign-ins. The hold is a session-level advisory lock on a connection of its
 * own. PostgreSQL releases it when that connection ends, so a holder that dies leaves nothing to
 * clear; a holder whose connection is cut takes the lock again, and one that finds it taken
 * meanwhile throws from a timer, which ends the process: it must not serve beside the new owner.
 */
import { setTimeout as wait } from "node:timers/promises";
import type { Store } from "@uketsugi/core";
import { PostgresDialect, sql } from "kysely";
import pg from "pg";
import { connect, type Db } from "./codec.ts";
import { StoreInUseError } from "./data-dir.ts";
import { migrate } from "./migrations.ts";
import { createStore } from "./store.ts";

export interface ServerStoreOptions {
  /** `postgres://user:password@host:port/database`. The database must exist. */
  readonly connectionString: string;
}

const INT8 = 20;

type Parser = (value: string) => unknown;

/** `bigint` as a number, as the embedded engine returns it: sequences and counts stay far below 2^53. */
const parserOf = (oid: number, format?: "text"): Parser =>
  oid === INT8 ? Number : (pg.types.getTypeParser(oid, format) as Parser);
const TYPES = { getTypeParser: parserOf as typeof pg.types.getTypeParser };

/** The advisory lock an owner holds: one number, the same in every version ("ukts" in ASCII). */
const HOLD_KEY = 0x756b7473;
/** How long a holder that lost its connection waits before it asks for the lock again. */
const RETAKE_EVERY_MS = 1000;

/**
 * The database a connection string names, as `host:port/database`: what stays the same when its
 * credentials change, and all of it that a message shows. It is `pg`'s own reading of the string,
 * defaults and environment included; nothing connects.
 */
export function serverStoreName(connectionString: string): string {
  const { host, port, database } = new pg.Client({ connectionString });
  return `${host}:${port}/${database ?? ""}`;
}

/** What a database that answers still lacks to hold a store, and what whoever runs it does about that. */
class Lacking extends Error {
  readonly remedy: string;
  constructor(what: string, remedy: string) {
    super(what);
    this.remedy = remedy;
  }
}

/** Thrown when a database cannot be reached or made ready. The message names it, never its credentials. */
export class StoreUnavailableError extends Error {
  /** What to do about it, where the database answered and said what it lacks; null where it did not. */
  readonly remedy: string | null;
  constructor(connectionString: string, cause: unknown) {
    const why = cause instanceof Error ? cause.message : String(cause);
    const name = serverStoreName(connectionString);
    super(`The PostgreSQL database ${name} could not be opened: ${why}`, { cause });
    this.name = "StoreUnavailableError";
    this.remedy = cause instanceof Lacking ? cause.remedy : null;
  }
}

/** PostgreSQL's code for a statement its role may not run. */
const INSUFFICIENT_PRIVILEGE = "42501";

/**
 * Makes sure the database has the two extensions the store needs, before anything is made in it:
 * a migration that failed on them would leave the migrator's own tables behind and say less.
 * pgvector is one only a superuser may add, so a database's ordinary owner is told what to ask for.
 */
async function requireExtensions(db: Db): Promise<void> {
  const found = await sql<{ name: string; installed: string | null; offered: string | null }>`
    select name, installed_version as installed, default_version as offered
    from pg_available_extensions where name in ('vector', 'pg_trgm')`.execute(db);
  const versions = new Map(found.rows.map((row) => [row.name, row.installed ?? row.offered]));
  const [major = 0, minor = 0] = (versions.get("vector") ?? "0").split(".").map(Number);
  if (!versions.has("pg_trgm") || major * 100 + minor < 7) {
    throw new Lacking(
      "its server needs the pg_trgm extension and pgvector 0.7 or newer " +
        `(found: pg_trgm ${versions.get("pg_trgm") ?? "none"}, vector ${versions.get("vector") ?? "none"})`,
      "Install them on the PostgreSQL server, then run this again.",
    );
  }
  const absent = found.rows.filter((row) => row.installed === null).map((row) => row.name);
  try {
    // Both or neither: one the role may add is not left behind when the other is refused.
    await db.transaction().execute(async (unit) => {
      for (const name of absent)
        await sql`create extension if not exists ${sql.id(name)}`.execute(unit);
    });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === INSUFFICIENT_PRIVILEGE))
      throw error;
    const statements = absent.map((name) => `CREATE EXTENSION IF NOT EXISTS ${name};`).join(" ");
    throw new Lacking(
      `the role in its address may not add the extensions a store needs (${absent.join(", ")})`,
      `Have a superuser of the PostgreSQL server run this in the database, once: ${statements} Then run this again.`,
    );
  }
}

/**
 * Takes the database's lock on a connection of its own and returns that connection. Refuses with
 * `StoreInUseError`, naming where the holder connected from and since when, when another has it.
 */
async function takeHold(connectionString: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString, application_name: "uketsugi" });
  await client.connect();
  try {
    const taken = await client.query<{ held: boolean }>("select pg_try_advisory_lock($1) as held", [
      HOLD_KEY,
    ]);
    if (taken.rows[0]?.held === true) return client;
    const holder = await client.query<{ address: string | null; since: Date | null }>(
      `select a.client_addr::text as address, a.backend_start as since
       from pg_locks l join pg_stat_activity a on a.pid = l.pid
       where l.locktype = 'advisory' and l.granted and l.classid = 0 and l.objid = $1
         and l.database = (select oid from pg_database where datname = current_database())`,
      [HOLD_KEY],
    );
    const { address = null, since = null } = holder.rows[0] ?? {};
    throw new StoreInUseError(
      `The PostgreSQL database ${serverStoreName(connectionString)} is in use by another ` +
        `uketsugi process (connected from ${address ?? "this machine"} since ` +
        `${since?.toISOString() ?? "a moment ago"}). Stop that process, or use the server it runs: ` +
        "one process serves a database at a time.",
    );
  } catch (error) {
    await client.end();
    throw error;
  }
}

/**
 * Holds the database for this process until `release` is called. A hold whose connection ends is
 * taken again as soon as the server lets it; if another process holds it by then, this one stops.
 */
async function holdDatabase(connectionString: string): Promise<() => Promise<void>> {
  let client = await takeHold(connectionString);
  let released = false;

  async function retake(): Promise<void> {
    while (!released) {
      try {
        client = await takeHold(connectionString);
        watch(client);
        return;
      } catch (error) {
        if (error instanceof StoreInUseError) {
          throw new Error(
            `uketsugi lost its hold on the database ${serverStoreName(connectionString)}: ` +
              "another process took it. This process stops so that two never serve one store.",
            { cause: error },
          );
        }
        // The server is away: its statements fail too. Ask again when it may be back.
        await wait(RETAKE_EVERY_MS, undefined, { ref: false });
      }
    }
  }

  function watch(held: pg.Client): void {
    // An error on an idle connection is followed by its end; without a listener it would end the process.
    held.on("error", () => undefined);
    held.on("end", () => {
      if (!released) void retake();
    });
  }

  watch(client);
  return async () => {
    released = true;
    await client.end();
  };
}

/** The pool on a database this process holds, migrated; what closes both. */
async function openHeld(connectionString: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const release = await holdDatabase(connectionString);
  const pool = new pg.Pool({ connectionString, types: TYPES });
  // A connection the server cut while it sat idle. The pool has dropped it and the next statement
  // opens another; without a listener Node would end the process over it.
  pool.on("error", () => undefined);
  const db = connect(new PostgresDialect({ pool }));
  const close = async (): Promise<void> => {
    await db.destroy();
    await release();
  };
  try {
    await requireExtensions(db);
    await migrate(db);
  } catch (error) {
    await close();
    throw error;
  }
  return { db, close };
}

/**
 * Opens the store on a PostgreSQL server, migrating the database as needed. Refuses with
 * `StoreInUseError` when another process holds the database, and with `StoreUnavailableError`
 * when it cannot be reached or made ready.
 */
export async function openServerStore(options: ServerStoreOptions): Promise<Store> {
  const { connectionString } = options;
  const { db, close } = await openHeld(connectionString).catch((error: unknown) => {
    throw error instanceof StoreInUseError
      ? error
      : new StoreUnavailableError(connectionString, error);
  });
  return createStore(db, close);
}
