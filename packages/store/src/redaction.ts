/**
 * Redaction: one operation that takes a fact's text out of every structure holding it. Each
 * statement below is one structure. What stays is a stub: the id, the author, the times and the
 * fact that replaced it. Who redacted it is the actor of its `FactRedacted` event.
 *
 * A fact that moved has entries in two logs, so the two statements on the log find a fact's
 * entries by their subject in whichever log holds them, and only for facts the scope was first
 * seen to hold.
 */
import type { ReadScope, UnitTarget } from "@uketsugi/core";
import { sql } from "kysely";
import { behindOf } from "./chain.ts";
import { scoped, type Db } from "./codec.ts";

/** What stands where a redacted fact's hashes were: a hash of a text can be tested against a guess of it. */
const NO_HASH = new Uint8Array(32);
/** The keys of an event's payload that hold a hash of the text the event describes. */
const HASH_KEYS = ["contentHash", "claimHash", "before", "after", "taken"];

/**
 * Redacts the fact and every fact superseded by it, directly or through others: a chain's earlier
 * links hold earlier wordings of the same text, and no search or list shows them to be redacted
 * one by one. A fact already redacted is left as it is. Returns the ids redacted now.
 */
export async function redactFacts(db: Db, target: UnitTarget, id: string): Promise<string[]> {
  const { orgId, at } = target;
  const scope = { orgId, audienceIds: [target.audienceId] };
  const chain = await behindOf(db, scope, [id]);
  const ids = chain.filter((fact) => !fact.redacted).map((fact) => fact.id);
  if (ids.length === 0) return [];

  // The row: its text, citations and vector; the search columns are generated from the text and empty with it.
  await db
    .updateTable("facts")
    .set({
      claim: null,
      detail: null,
      question: null,
      citations: null,
      vector: null,
      contentHash: NO_HASH,
      claimHash: NO_HASH,
      redactedAt: at,
      updatedAt: at,
    })
    .where(scoped(scope))
    .where("id", "in", ids)
    .execute();
  // Identifiers, and the facts it cited.
  await db.deleteFrom("factIdents").where("orgId", "=", orgId).where("factId", "in", ids).execute();
  await db.deleteFrom("citedFacts").where("orgId", "=", orgId).where("factId", "in", ids).execute();
  // Confirmations: what a person wrote of their check.
  await db.deleteFrom("confirmations").where(scoped(scope)).where("factId", "in", ids).execute();
  // The fact's open flags close.
  await db
    .updateTable("flags")
    .set({ clearedAt: at })
    .where(scoped(scope))
    .where("factId", "in", ids)
    .where("clearedAt", "is", null)
    .execute();
  // Pending jobs about the fact.
  await db.deleteFrom("outbox").where(scoped(scope)).where("subject", "in", ids).execute();
  // Events: the hashes of the text they described, in every log.
  await db
    .updateTable("events")
    .set({ payload: sql<string>`payload - ${HASH_KEYS}::text[]` })
    .where("orgId", "=", orgId)
    .where("subject", "in", ids)
    .execute();
  return ids;
}

/**
 * Takes hashes out of the `taken` list of the merge events about one fact: what its survivor took
 * from it and has now given back. The rest of each list stays, so a later revert still finds it.
 */
export async function forgetTaken(
  db: Db,
  scope: ReadScope,
  subject: string,
  hashes: readonly string[],
): Promise<void> {
  if (hashes.length === 0) return;
  const held = await db
    .selectFrom("facts")
    .select("id")
    .where(scoped(scope))
    .where("id", "=", subject)
    .executeTakeFirst();
  if (held === undefined) return;
  const given = [...hashes];
  await db
    .updateTable("events")
    .set({
      payload: sql<string>`jsonb_set(payload, '{taken}', (payload -> 'taken') - ${given}::text[])`,
    })
    .where("orgId", "=", scope.orgId)
    .where("subject", "=", subject)
    .where("kind", "=", "FactSuperseded")
    .where(sql<boolean>`jsonb_typeof(payload -> 'taken') = 'array'`)
    .execute();
}
