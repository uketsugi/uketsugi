/**
 * Removing a person, and what an account's deletion takes that no project's deletion reaches, and what it leaves. The
 * person's row stays, as a removed person's does, so that their subject is still refused, but it
 * holds only a hash of the subject and a name that names nobody.
 */
import { createHash } from "node:crypto";
import type { ErasedAccount } from "@uketsugi/core";
import { groupIdsOf, lockHeads } from "./audiences.ts";
import { endCredentials } from "./credentials.ts";
import type { Db } from "./codec.ts";
import { forgetAuthored } from "./forget.ts";

/** What the name of an account that was deleted reads as, wherever a name is shown. */
export const DELETED_NAME = "deleted account";

/** What an erased account's row holds in place of its subject: a hash, in a form no subject has. */
export function erasedSubject(subject: string): string {
  return `erased:${createHash("sha256").update(subject).digest("hex")}`;
}

/**
 * Under the head of the person's own audience, which every write of theirs takes first: deletes
 * whatever they wrote that is still anywhere (a record in a group they have left, a write that
 * came after their projects were deleted), what they wrote on other people's records, what no
 * project holds, and their credentials, then replaces the subject by its hash and the name.
 */
export async function eraseResidue(db: Db, orgId: string, id: string): Promise<ErasedAccount> {
  const own = await db
    .selectFrom("audiences")
    .select("id")
    .where("orgId", "=", orgId)
    .where("ownerId", "=", id)
    .execute();
  await lockHeads(
    db,
    orgId,
    own.map((audience) => audience.id),
  );
  const { facts, tasks } = await forgetAuthored(db, orgId, id);
  await db
    .deleteFrom("confirmations")
    .where("orgId", "=", orgId)
    .where("person", "=", id)
    .execute();
  await db.deleteFrom("taskNotes").where("orgId", "=", orgId).where("author", "=", id).execute();
  for (const table of ["sessions", "projectChoices", "projectNames"] as const) {
    await db.deleteFrom(table).where("orgId", "=", orgId).where("principalId", "=", id).execute();
  }
  const credentials = await db
    .deleteFrom("credentials")
    .where("orgId", "=", orgId)
    .where("principalId", "=", id)
    .executeTakeFirst();
  const row = await db
    .selectFrom("principals")
    .select("subject")
    .where("orgId", "=", orgId)
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  await db
    .updateTable("principals")
    .set({ displayName: DELETED_NAME, subject: erasedSubject(row.subject) })
    .where("orgId", "=", orgId)
    .where("id", "=", id)
    .execute();
  return { credentials: Number(credentials.numDeletedRows), facts, tasks };
}

/** The person leaves their organization's people and its groups, and their credentials end; 0 when they had left already. */
export async function removeIn(trx: Db, orgId: string, id: string, at: Date): Promise<number> {
  const gone = await trx
    .updateTable("principals")
    .set({ removedAt: at })
    .where("orgId", "=", orgId)
    .where("id", "=", id)
    .where("removedAt", "is", null)
    .executeTakeFirst();
  if (gone.numUpdatedRows === 0n) return 0;
  await lockHeads(trx, orgId, await groupIdsOf(trx, orgId, id));
  await trx
    .deleteFrom("audienceMembers")
    .where("orgId", "=", orgId)
    .where("principalId", "=", id)
    .execute();
  return endCredentials(trx, orgId, id, at);
}
