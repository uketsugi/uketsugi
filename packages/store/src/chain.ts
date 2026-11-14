/**
 * The two walks of a chain of superseded facts: ahead, to the live fact nothing has replaced, and
 * behind, to every fact a fact replaced. Both stay inside the scope they are given.
 */
import type { ReadScope } from "@uketsugi/core";
import { sql } from "kysely";
import { scoped, uuidsOf, type Db } from "./codec.ts";

/**
 * The live fact at the head of each superseded fact's chain, in one statement: every link is
 * followed to the fact nothing has replaced. `union` ends the walk even on a loop, which
 * `supersede` and the table's checks do not let form.
 */
export async function headsIn(
  db: Db,
  scope: ReadScope,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const from = uuidsOf(ids);
  if (from.length === 0) return new Map();
  const found = await sql<{ origin: string; head: string }>`
    with recursive chain (origin, id, next) as (
      select id, id, superseded_by from facts
      where ${scoped(scope)} and id = any(${from}::uuid[]) and superseded_by is not null
      union
      select chain.origin, f.id, f.superseded_by
      from chain join facts f on f.id = chain.next and ${scoped(scope, "f")}
    )
    select origin, id as head from chain where next is null`.execute(db);
  return new Map(found.rows.map((row) => [row.origin, row.head]));
}

/**
 * The facts given that the scope holds, and every fact superseded by one of them, directly or
 * through others: what a redaction and a move take together, since a chain's earlier links are
 * earlier wordings of the same fact. Each comes with whether it is already a redacted stub.
 */
export async function behindOf(
  db: Db,
  scope: ReadScope,
  ids: readonly string[],
): Promise<{ id: string; redacted: boolean }[]> {
  const from = uuidsOf(ids);
  if (from.length === 0) return [];
  const found = await sql<{ id: string; redacted: boolean }>`
    with recursive behind (id, redacted_at) as (
      select id, redacted_at from facts where ${scoped(scope)} and id = any(${from}::uuid[])
      union
      select f.id, f.redacted_at
      from behind join facts f on f.superseded_by = behind.id and ${scoped(scope, "f")}
    )
    select id, redacted_at is not null as redacted from behind`.execute(db);
  return found.rows;
}
