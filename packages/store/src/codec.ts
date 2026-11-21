/** How domain values cross into PostgreSQL and back, and the rules every statement shares. */
import {
  isUuid,
  type Actor,
  type ModelVector,
  type ReadScope,
  type RunnerKind,
  type UnitTarget,
} from "@uketsugi/core";
import {
  CamelCasePlugin,
  Kysely,
  sql,
  type Dialect,
  type KyselyPlugin,
  type RawBuilder,
} from "kysely";
import type { Database } from "./schema.ts";

/** A database or an open transaction: every statement runs on one of these. */
export type Db = Kysely<Database>;

/**
 * A connection whose statements and rows use the domain's names: `orgId` here is `org_id` there.
 * The keys inside a JSON value are left as they were stored. Text written with the `sql` tag is
 * sent as written, in the database's names.
 */
export function connect(dialect: Dialect, plugins: readonly KyselyPlugin[] = []): Db {
  const names = new CamelCasePlugin({ maintainNestedObjectKeys: true });
  return new Kysely<Database>({ dialect, plugins: [names, ...plugins] });
}

/** A repository outside units: its statements run on the store's connection. */
export abstract class Repo {
  protected readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }
}

/** A repository inside a unit: its statements run in the unit's transaction, in the unit's audience. */
export abstract class UnitRepo extends Repo {
  protected readonly target: UnitTarget;
  /** The unit's one audience as the scope its statements keep. */
  protected readonly scope: ReadScope;

  constructor(db: Db, target: UnitTarget) {
    super(db);
    this.target = target;
    this.scope = { orgId: target.orgId, audienceIds: [target.audienceId] };
  }
}

function prefix(alias: string | undefined): RawBuilder<unknown> {
  return sql.raw(alias === undefined ? "" : `${alias}.`);
}

/**
 * The rule every statement on a data table keeps: only rows of the organization and the audiences
 * of the scope. A scope with no audience matches no row. `alias` names the table in a statement
 * that reads more than one.
 */
export function scoped(scope: ReadScope, alias?: string): RawBuilder<boolean> {
  const at = prefix(alias);
  const audiences = [...scope.audienceIds];
  return sql<boolean>`(${at}org_id = ${scope.orgId} and ${at}audience_id = any(${audiences}::uuid[]))`;
}

/** The rule for a live fact: one that is not superseded and still has its text. */
export function live(alias?: string): RawBuilder<boolean> {
  const at = prefix(alias);
  return sql<boolean>`(${at}status <> 'superseded' and ${at}claim is not null)`;
}

/** The ids among `values` that can be bound as uuids. An id that cannot is read as absent, never sent. */
export function uuidsOf(values: readonly string[]): string[] {
  return values.filter(isUuid);
}

export function toBytes(hex: string): Uint8Array {
  return Buffer.from(hex, "hex");
}

/** A vector as a column takes it: the halfvec, or null unless the store's recorded model is the vector's. */
export function vectorUnder(vector: ModelVector | null): RawBuilder<string | null> {
  if (vector === null) return sql`null::halfvec`;
  return sql`(case when (select model from embedding_model) = ${vector.model}
                   then ${toHalfvec(vector.vector)}::halfvec end)`;
}

/** A vector in the text form a halfvec column takes. */
export function toHalfvec(vector: Float32Array): string {
  return `[${Array.from(vector).join(",")}]`;
}

/** Who performed an act, as its two columns hold it: a person's id, or a job as `name:runner`. */
export function actorColumns(actor: Actor): { person: string | null; job: string | null } {
  return actor.kind === "person"
    ? { person: actor.id, job: null }
    : { person: null, job: `${actor.job}:${actor.runner}` };
}

/** The actor two columns hold: what `actorColumns` wrote. */
export function actorOf(person: string | null, job: string | null): Actor {
  if (person !== null) return { kind: "person", id: person };
  const [name = "", runner = ""] = (job ?? "").split(":");
  return { kind: "job", job: name, runner: runner as RunnerKind };
}

/** A text column to order by, in byte order on every host: a server's database may collate otherwise than the embedded engine does. */
export function inByteOrder(column: string): RawBuilder<string> {
  return sql<string>`${sql.ref(column)} collate "C"`;
}
