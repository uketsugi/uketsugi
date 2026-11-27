/**
 * The migrations and their runner. Kysely's migrator applies each migration once, in name order,
 * and records it in `kysely_migration`. A released migration is never edited; a change is a new
 * one. The same migrations run on embedded and on server PostgreSQL.
 */
import { Migrator, type Migration } from "kysely/migration";
import type { Db } from "./codec.ts";
import { INIT_0001 } from "./migrations/0001_init.ts";
import { MODEL_STEP_0002 } from "./migrations/0002_model_step.ts";
import { DIGEST_FAILURE_0003 } from "./migrations/0003_digest_failure.ts";
import { UNREAD_0004 } from "./migrations/0004_unread.ts";
import { EMBEDDING_MODEL_0005 } from "./migrations/0005_embedding_model.ts";
import { PERSON_REMOVED_0006 } from "./migrations/0006_person_removed.ts";
import { PATH_PROJECTS_0007 } from "./migrations/0007_path_projects.ts";

/**
 * Every migration, by the name it is recorded under. `0001_init.3` is the schema 0.1.0 released:
 * it is never edited again, and what a later version needs is a migration after it.
 */
export const MIGRATIONS: Record<string, Migration> = {
  "0001_init.3": INIT_0001,
  "0002_model_step": MODEL_STEP_0002,
  "0003_digest_failure": DIGEST_FAILURE_0003,
  "0004_unread": UNREAD_0004,
  "0005_embedding_model": EMBEDDING_MODEL_0005,
  "0006_person_removed": PERSON_REMOVED_0006,
  "0007_path_projects": PATH_PROJECTS_0007,
};

/**
 * Thrown when a store has recorded a migration this build does not have: a newer release made it
 * (or a build from before the first release did). Nothing was changed. The way out is a build
 * that has the migration, or a snapshot taken before it was applied.
 */
export class StoreNewerError extends Error {
  /** The recorded migration this build lacks, when the migrator named it. */
  readonly missing: string | null;
  constructor(why: string, cause: unknown) {
    super(
      "This store was made by another build of uketsugi, with a schema this build cannot read " +
        `(${why}). Nothing was changed: the build that made it still opens it. ` +
        "Run that build, or put back a copy of the store from before the newer build opened it.",
      { cause },
    );
    this.name = "StoreNewerError";
    this.missing = /migration (\S+) is missing/.exec(why)?.[1] ?? null;
  }
}

/** The migrator over a set of migrations: this package's, unless a test of an upgrade gives fewer. */
function migratorOf(db: Db, migrations: Record<string, Migration>): Migrator {
  return new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
}

/**
 * Brings a database to the newest schema. Applying nothing is not an error. The pending migrations
 * run in one transaction, and PostgreSQL rolls a schema change back with the rest: a migration
 * that fails leaves the store exactly as it was, at the version it had.
 */
export async function migrate(
  db: Db,
  migrations: Record<string, Migration> = MIGRATIONS,
): Promise<void> {
  const { error } = await migratorOf(db, migrations).migrateToLatest();
  if (error !== undefined) {
    const why = error instanceof Error ? error.message : "the migrator gave no reason";
    if (why.startsWith("corrupted migrations")) throw new StoreNewerError(why, error);
    throw new Error(
      `The store could not be brought to this version's schema (${why}). ` +
        "Nothing was changed: the version that last opened it still can.",
      { cause: error },
    );
  }
}

/** Which migrations a database has applied and which it has yet to: an upgrade has both. */
export async function migrationState(
  db: Db,
  migrations: Record<string, Migration> = MIGRATIONS,
): Promise<{ applied: string[]; pending: string[] }> {
  const all = await migratorOf(db, migrations).getMigrations();
  const namesOf = (done: boolean): string[] =>
    all.filter((entry) => (entry.executedAt !== undefined) === done).map((entry) => entry.name);
  return { applied: namesOf(true), pending: namesOf(false) };
}
