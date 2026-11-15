import {
  isUuid,
  toHex,
  type CitationsChange,
  type Fact,
  type FactContent,
  type FactListQuery,
  type FactsRepo,
  type NewFact,
  type ReadScope,
  type StoredEvent,
  type UnitFacts,
  type VectorChange,
} from "@uketsugi/core";
import { sql, type InferResult } from "kysely";
import { behindOf, headsIn } from "./chain.ts";
import { live, Repo, scoped, toBytes, toHalfvec, UnitRepo, uuidsOf, type Db } from "./codec.ts";
import { forgetTaken, redactFacts } from "./redaction.ts";
import { toEvent } from "./review.ts";

/** The facts of a scope as a read returns them: without the search columns, and with whether a vector is stored instead of the vector. */
function factsIn(db: Db, scope: ReadScope) {
  return db
    .selectFrom("facts")
    .select([
      "orgId",
      "id",
      "audienceId",
      "project",
      "claim",
      "detail",
      "question",
      "citations",
      "status",
      "author",
      "contentHash",
      "claimHash",
      "supersededBy",
      "createdAt",
      "updatedAt",
      "redactedAt",
      "digestSession",
      sql<boolean>`vector is not null`.as("embedded"),
    ])
    .where(scoped(scope));
}

function toFact(row: InferResult<ReturnType<typeof factsIn>>[number]): Fact {
  return {
    ...row,
    citations: row.citations ?? [],
    contentHash: toHex(row.contentHash),
    claimHash: toHex(row.claimHash),
  };
}

async function factIn(db: Db, scope: ReadScope, id: string): Promise<Fact | null> {
  if (!isUuid(id)) return null;
  const row = await factsIn(db, scope).where("id", "=", id).executeTakeFirst();
  return row === undefined ? null : toFact(row);
}

async function factsAmong(db: Db, scope: ReadScope, ids: readonly string[]): Promise<Fact[]> {
  const wanted = uuidsOf(ids);
  if (wanted.length === 0) return [];
  return (await factsIn(db, scope).where("id", "in", wanted).execute()).map(toFact);
}

/** The columns a publish and a correction both write. */
function textColumns(content: FactContent) {
  return {
    claim: content.claim,
    detail: content.detail,
    question: content.question,
    citations: JSON.stringify(content.citations),
    contentHash: toBytes(content.contentHash),
    claimHash: toBytes(content.claimHash),
  };
}

/** Replaces a fact's identifier rows with those of its current text. */
async function writeIdents(
  db: Db,
  orgId: string,
  factId: string,
  idents: readonly string[],
): Promise<void> {
  await db
    .deleteFrom("factIdents")
    .where("orgId", "=", orgId)
    .where("factId", "=", factId)
    .execute();
  const rows = [...new Set(idents)].map((ident) => ({ orgId, factId, ident }));
  if (rows.length > 0) await db.insertInto("factIdents").values(rows).execute();
}

/** Replaces the rows of the facts a fact cites with those of its current citations. */
async function writeCited(
  db: Db,
  orgId: string,
  factId: string,
  cited: readonly string[],
): Promise<void> {
  await db
    .deleteFrom("citedFacts")
    .where("orgId", "=", orgId)
    .where("factId", "=", factId)
    .execute();
  const rows = [...new Set(cited)].map((citedFact) => ({ orgId, factId, citedFact }));
  if (rows.length > 0) await db.insertInto("citedFacts").values(rows).execute();
}

/** The facts a fact replaced, directly or through others, that the scope holds. */
async function factsBehind(db: Db, scope: ReadScope, id: string): Promise<Fact[]> {
  const chain = await behindOf(db, scope, [id]);
  const ids = chain.map((fact) => fact.id).filter((member) => member !== id);
  return factsAmong(db, scope, ids);
}

/** Facts inside a unit: scoped to the unit's organization and audience. */
export class SqlUnitFacts extends UnitRepo implements UnitFacts {
  /** An update of one fact of the unit's audience. */
  private one(id: string) {
    return this.db.updateTable("facts").where(scoped(this.scope)).where("id", "=", id);
  }

  /**
   * Refuses to go on when an update matched no fact. A fact's identifier and cited-fact rows carry
   * no audience of their own: they are written only for a fact the unit's audience holds.
   */
  private mustHold(id: string, result: { numUpdatedRows: bigint }): void {
    if (result.numUpdatedRows > 0n) return;
    throw new Error(
      `fact ${id} is not a fact of the unit's audience, so nothing of it was written`,
    );
  }

  get(id: string): Promise<Fact | null> {
    return factIn(this.db, this.scope, id);
  }

  getMany(ids: readonly string[]): Promise<Fact[]> {
    return factsAmong(this.db, this.scope, ids);
  }

  async writtenBy(author: string, project: string): Promise<Fact[]> {
    const rows = await factsIn(this.db, this.scope)
      .where("author", "=", author)
      .where("project", "=", project)
      .execute();
    return rows.map(toFact);
  }

  behind(id: string): Promise<Fact[]> {
    return factsBehind(this.db, this.scope, id);
  }

  async merges(id: string): Promise<StoredEvent[]> {
    // A fact that moved has entries in two logs: they are found by their subject, for a fact the
    // unit's audience was first seen to hold.
    if ((await this.get(id)) === null) return [];
    const rows = await this.db
      .selectFrom("events")
      .selectAll()
      .where("orgId", "=", this.target.orgId)
      .where("subject", "=", id)
      .where("kind", "=", "FactSuperseded")
      .orderBy("at", "desc")
      .orderBy("seq", "desc")
      .execute();
    return rows.map(toEvent);
  }

  async findByClaimHash(author: string, project: string, claimHash: string): Promise<Fact | null> {
    const row = await factsIn(this.db, this.scope)
      .where("author", "=", author)
      .where("project", "=", project)
      .where("claimHash", "=", toBytes(claimHash))
      .where(live())
      .orderBy("createdAt")
      .executeTakeFirst();
    return row === undefined ? null : toFact(row);
  }

  async insert(fact: NewFact): Promise<void> {
    const { orgId, audienceId, at } = this.target;
    const { content } = fact;
    await this.db
      .insertInto("facts")
      .values({
        orgId,
        id: fact.id,
        audienceId,
        project: fact.project,
        ...textColumns(content),
        vector: fact.vector === null ? null : toHalfvec(fact.vector),
        status: "unconfirmed",
        author: fact.author,
        createdAt: at,
        updatedAt: at,
        digestSession: fact.digestSession ?? null,
      })
      .execute();
    await writeIdents(this.db, orgId, fact.id, content.idents);
    await writeCited(this.db, orgId, fact.id, content.citedFacts);
  }

  async rewrite(id: string, content: FactContent, vector: VectorChange): Promise<void> {
    const stored = vector === null || vector === "kept" ? null : toHalfvec(vector);
    const rewritten = await this.one(id)
      .set({
        ...textColumns(content),
        ...(vector === "kept" ? {} : { vector: stored }),
        updatedAt: this.target.at,
        // Its author's own words now: no model wrote what it says.
        digestSession: null,
      })
      .executeTakeFirst();
    this.mustHold(id, rewritten);
    await writeIdents(this.db, this.target.orgId, id, content.idents);
    await writeCited(this.db, this.target.orgId, id, content.citedFacts);
  }

  async setCitations(id: string, change: CitationsChange): Promise<void> {
    const changed = await this.one(id)
      .set({
        citations: JSON.stringify(change.citations),
        contentHash: toBytes(change.contentHash),
        vector: null,
        updatedAt: this.target.at,
      })
      .executeTakeFirst();
    this.mustHold(id, changed);
    await writeCited(this.db, this.target.orgId, id, change.citedFacts);
  }

  async supersede(id: string, by: string): Promise<void> {
    const successor = this.db
      .selectFrom("facts as s")
      .select("s.id")
      .where(scoped(this.scope, "s"))
      .where("s.id", "=", by)
      .where("s.status", "<>", "superseded");
    const done = await this.one(id)
      .set({ status: "superseded", supersededBy: by, updatedAt: this.target.at })
      .where("id", "<>", by)
      .where("status", "<>", "superseded")
      .where((eb) => eb.exists(successor))
      .executeTakeFirst();
    if (done.numUpdatedRows === 0n) {
      throw new Error(
        `fact ${id} was not superseded by ${by}: both must be facts of the unit's audience ` +
          "that nothing has superseded, and not the same fact",
      );
    }
  }

  async setStatus(id: string, status: "confirmed" | "unconfirmed"): Promise<void> {
    await this.one(id).set({ status, updatedAt: this.target.at }).execute();
  }

  async restore(id: string, status: "confirmed" | "unconfirmed"): Promise<void> {
    await this.one(id)
      .set({ status, supersededBy: null, updatedAt: this.target.at })
      .where("supersededBy", "is not", null)
      .execute();
  }

  heads(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    return headsIn(this.db, this.scope, ids);
  }

  redact(id: string): Promise<string[]> {
    return redactFacts(this.db, this.target, id);
  }

  forgetTaken(id: string, hashes: readonly string[]): Promise<void> {
    return forgetTaken(this.db, this.scope, id, hashes);
  }

  async citing(id: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("citedFacts as c")
      .innerJoin("facts as f", (join) =>
        join.onRef("f.orgId", "=", "c.orgId").onRef("f.id", "=", "c.factId"),
      )
      .select("c.factId")
      .where("c.citedFact", "=", id)
      .where(scoped(this.scope, "f"))
      .where(live("f"))
      .execute();
    return rows.map((row) => row.factId);
  }
}

/** Facts outside a unit: every read is scoped by organization and visible audiences. */
export class SqlFacts extends Repo implements FactsRepo {
  get(scope: ReadScope, id: string): Promise<Fact | null> {
    return factIn(this.db, scope, id);
  }

  getMany(scope: ReadScope, ids: readonly string[]): Promise<Fact[]> {
    return factsAmong(this.db, scope, ids);
  }

  heads(scope: ReadScope, ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    return headsIn(this.db, scope, ids);
  }

  behind(scope: ReadScope, id: string): Promise<Fact[]> {
    return factsBehind(this.db, scope, id);
  }

  async list(scope: ReadScope, query: FactListQuery): Promise<Fact[]> {
    let rows = factsIn(this.db, scope);
    if (query.project !== undefined) rows = rows.where("project", "=", query.project);
    if (query.author !== undefined) rows = rows.where("author", "=", query.author);
    if (query.before !== undefined) {
      const { updatedAt, id } = query.before;
      rows = rows.where((eb) => eb(eb.refTuple("updatedAt", "id"), "<", eb.tuple(updatedAt, id)));
    }
    const page = await rows
      .orderBy("updatedAt", "desc")
      .orderBy("id", "desc")
      .limit(query.limit)
      .execute();
    return page.map(toFact);
  }

  async count(scope: ReadScope, project: string): Promise<number> {
    const row = await this.db
      .selectFrom("facts")
      .select((eb) => eb.fn.countAll<number>().as("facts"))
      .where(scoped(scope))
      .where("project", "=", project)
      .where(live())
      .executeTakeFirstOrThrow();
    return row.facts;
  }

  async setVector(
    orgId: string,
    id: string,
    contentHash: string,
    vector: Float32Array,
  ): Promise<boolean> {
    if (!isUuid(id)) return false;
    const result = await this.db
      .updateTable("facts")
      .set({ vector: toHalfvec(vector) })
      .where("orgId", "=", orgId)
      .where("id", "=", id)
      .where("contentHash", "=", toBytes(contentHash))
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}
