import { EVERYONE, type Group } from "@uketsugi/core";
import { sql, type Selectable } from "kysely";
import type { Db } from "./codec.ts";
import type { Database } from "./schema.ts";

/**
 * An audience with its head row, which every unit on it locks, unless an audience it would
 * duplicate exists: a person has one of their own, and a group's name is its organization's
 * alone. Says whether it was made.
 */
export async function insertAudience(
  db: Db,
  audience: Selectable<Database["audiences"]>,
): Promise<boolean> {
  const created = await db
    .insertInto("audiences")
    .values(audience)
    .onConflict((conflict) => conflict.doNothing())
    .returning("id")
    .executeTakeFirst();
  if (created === undefined) return false;
  const { orgId, id: audienceId } = audience;
  await db.insertInto("audienceHead").values({ orgId, audienceId, lastSeq: 0 }).execute();
  return true;
}

/**
 * Puts a person in the organization's group `everyone`, which is made, with everyone who is
 * there, when this is its second person.
 */
export async function joinEveryone(
  db: Db,
  orgId: string,
  everyoneId: string,
  person: string,
): Promise<void> {
  const made = await insertAudience(db, {
    orgId,
    id: everyoneId,
    kind: "group",
    ownerId: null,
    name: EVERYONE,
  });
  const group = made ? everyoneId : (await groupNamed(db, orgId, EVERYONE))?.id;
  if (group === undefined) throw new Error("the group everyone could not be found");
  await addMembers(db, orgId, group, made ? undefined : person);
}

/**
 * Takes the heads of groups, in the order given (the order of their ids): a unit that writes into a
 * group holds its head, so what removes a person from it waits for the unit, and a unit that comes
 * after sees the removal.
 */
export async function lockHeads(db: Db, orgId: string, groupIds: readonly string[]): Promise<void> {
  for (const audienceId of groupIds) {
    await db
      .selectFrom("audienceHead")
      .select("lastSeq")
      .where("orgId", "=", orgId)
      .where("audienceId", "=", audienceId)
      .forUpdate()
      .execute();
  }
}

/** The ids of the groups a person is a member of, in order. */
export async function groupIdsOf(db: Db, orgId: string, person: string): Promise<string[]> {
  const rows = await db
    .selectFrom("audienceMembers")
    .select("audienceId")
    .where("orgId", "=", orgId)
    .where("principalId", "=", person)
    .orderBy("audienceId")
    .execute();
  return rows.map((row) => row.audienceId);
}

/** An organization's groups: their ids and names. */
export function groupRows(db: Db, orgId: string) {
  return db
    .selectFrom("audiences")
    .select(["id", "name"])
    .where("orgId", "=", orgId)
    .where("kind", "=", "group");
}

async function groupNamed(db: Db, orgId: string, name: string): Promise<Group | undefined> {
  const row = await groupRows(db, orgId).where("name", "=", name).executeTakeFirst();
  return row === undefined || row.name === null ? undefined : { id: row.id, name: row.name };
}

/** Adds one person, or every person the organization has, to a group; those in it already stay. */
export async function addMembers(
  db: Db,
  orgId: string,
  groupId: string,
  person?: string,
): Promise<void> {
  const only = person === undefined ? sql`` : sql`and id = ${person}`;
  await sql`insert into audience_members (org_id, audience_id, principal_id)
    select org_id, ${groupId}::uuid, id from principals
    where org_id = ${orgId} and removed_at is null ${only}
    on conflict do nothing`.execute(db);
}
