import type { CredentialKind, NewCredential } from "@uketsugi/core";
import { toBytes, type Db } from "./codec.ts";

export async function insertCredential(db: Db, credential: NewCredential): Promise<void> {
  const { orgId, id, principalId, kind, label, createdAt } = credential;
  const tokenHash = toBytes(credential.tokenHash);
  await db
    .insertInto("credentials")
    .values({ orgId, id, principalId, kind, label, createdAt, tokenHash })
    .execute();
}

/** Ends a person's live credentials at `at`, of one kind or of every kind. Returns how many it ended. */
export async function endCredentials(
  db: Db,
  orgId: string,
  principalId: string,
  at: Date,
  kind?: CredentialKind,
): Promise<number> {
  const live = db
    .updateTable("credentials")
    .where("principalId", "=", principalId)
    .where("orgId", "=", orgId)
    .where("revokedAt", "is", null)
    .set({ revokedAt: at });
  const ended = await (
    kind === undefined ? live : live.where("kind", "=", kind)
  ).executeTakeFirst();
  return Number(ended.numUpdatedRows);
}
