import type {
  Caller,
  Credential,
  CredentialKind,
  DirectoryRepo,
  Group,
  GroupMembers,
  InvitationRecord,
  NewCredential,
  NewInvitation,
  Person,
  PrincipalSeed,
} from "@uketsugi/core";
import type { Selectable } from "kysely";
import { insertCredential, endCredentials } from "./credentials.ts";
import {
  addMembers,
  groupIdsOf,
  lockHeads,
  groupRows,
  insertAudience,
  joinEveryone,
} from "./audiences.ts";
import { inByteOrder, Repo, toBytes, uuidsOf, type Db } from "./codec.ts";
import type { Database } from "./schema.ts";

type PrincipalRow = Pick<
  Selectable<Database["principals"]>,
  "orgId" | "id" | "displayName" | "removedAt"
>;

/** How often a token's last use is written: a busy token costs one write a minute, not one a call. */
const LAST_USE_STEP_MS = 60_000;

/** A principal with its private audience and that audience's head row, unless its subject is taken. */
async function insertPrincipal(db: Db, seed: PrincipalSeed): Promise<void> {
  const { orgId, principalId, audienceId, subject } = seed;
  // The first principal of an organization made it, and is its administrator.
  const there = await db
    .selectFrom("principals")
    .select("id")
    .where("orgId", "=", orgId)
    .executeTakeFirst();
  const created = await db
    .insertInto("principals")
    .values({
      orgId,
      id: principalId,
      displayName: seed.displayName,
      subject,
      administrator: there === undefined,
    })
    .onConflict((conflict) => conflict.column("subject").doNothing())
    .returning("id")
    .executeTakeFirst();
  if (created === undefined) return;
  await insertAudience(db, {
    orgId,
    id: audienceId,
    kind: "private",
    ownerId: principalId,
    name: null,
  });
}

/** Principals, their credentials and their audiences. */
export class SqlDirectory extends Repo implements DirectoryRepo {
  /**
   * The caller a principal is, signed in with a credential or with none. Their visible set is
   * their own audience and the groups they are a member of. A person who was removed is nobody.
   */
  private async personAs(
    principal: PrincipalRow | undefined,
    credentialId: string | null,
  ): Promise<Caller | null> {
    if (principal === undefined || principal.removedAt !== null) return null;
    const own = await this.db
      .selectFrom("audiences")
      .select("id")
      .where("orgId", "=", principal.orgId)
      .where("kind", "=", "private")
      .where("ownerId", "=", principal.id)
      .executeTakeFirst();
    if (own === undefined) return null;
    const rows = await this.db
      .selectFrom("audienceMembers as m")
      .innerJoin("audiences as a", (join) =>
        join.onRef("a.orgId", "=", "m.orgId").onRef("a.id", "=", "m.audienceId"),
      )
      .select(["a.id", "a.name"])
      .where("m.orgId", "=", principal.orgId)
      .where("m.principalId", "=", principal.id)
      .orderBy("a.id")
      .execute();
    const groups = rows.flatMap((row) =>
      row.name === null ? [] : [{ id: row.id, name: row.name }],
    );
    return {
      orgId: principal.orgId,
      principalId: principal.id,
      displayName: principal.displayName,
      credentialId,
      privateAudienceId: own.id,
      groups,
      visibleAudienceIds: [own.id, ...groups.map((group) => group.id)],
    };
  }

  private principals() {
    return this.db
      .selectFrom("principals")
      .select(["orgId", "id", "displayName", "removedAt", "administrator"]);
  }

  /** A credential's record. Its token's hash never leaves the store. */
  private credentialRecords() {
    return this.db
      .selectFrom("credentials")
      .select([
        "orgId",
        "id",
        "principalId",
        "kind",
        "label",
        "createdAt",
        "lastUsedAt",
        "revokedAt",
      ]);
  }

  private async bySubject(subject: string): Promise<Caller | null> {
    const principal = await this.principals().where("subject", "=", subject).executeTakeFirst();
    return this.personAs(principal, null);
  }

  /** The caller a live credential's record belongs to. */
  private async byCredential(credential: Credential | undefined): Promise<Caller | null> {
    if (credential === undefined) return null;
    const principal = await this.principals()
      .where("orgId", "=", credential.orgId)
      .where("id", "=", credential.principalId)
      .executeTakeFirst();
    return this.personAs(principal, credential.id);
  }

  async ensurePrincipal(seed: PrincipalSeed): Promise<Caller> {
    const existing = await this.bySubject(seed.subject);
    if (existing !== null) return existing;
    await this.db.transaction().execute((trx) => insertPrincipal(trx, seed));
    const caller = await this.bySubject(seed.subject);
    if (caller === null) throw new Error(`the principal ${seed.subject} could not be created`);
    return caller;
  }

  async addPerson(
    seed: PrincipalSeed,
    everyoneId: string,
    credentials: readonly NewCredential[],
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await insertPrincipal(trx, seed);
      await joinEveryone(trx, seed.orgId, everyoneId, seed.principalId);
      for (const credential of credentials) await insertCredential(trx, credential);
    });
  }

  async groups(orgId: string): Promise<GroupMembers[]> {
    const groups = await groupRows(this.db, orgId).orderBy(inByteOrder("name")).execute();
    const members = await this.db
      .selectFrom("audienceMembers as m")
      .innerJoin("principals as p", (join) =>
        join.onRef("p.orgId", "=", "m.orgId").onRef("p.id", "=", "m.principalId"),
      )
      .select(["m.audienceId", "p.id"])
      .where("m.orgId", "=", orgId)
      .where("p.removedAt", "is", null)
      .orderBy("p.id")
      .execute();
    return groups.flatMap((group) =>
      group.name === null
        ? []
        : [
            {
              id: group.id,
              name: group.name,
              members: members.filter((row) => row.audienceId === group.id).map((row) => row.id),
            },
          ],
    );
  }

  createGroup(orgId: string, group: Group): Promise<boolean> {
    return this.db.transaction().execute((trx) =>
      insertAudience(trx, {
        orgId,
        id: group.id,
        kind: "group",
        ownerId: null,
        name: group.name,
      }),
    );
  }

  addMember(orgId: string, groupId: string, principalId: string): Promise<void> {
    return addMembers(this.db, orgId, groupId, principalId);
  }

  removeMember(orgId: string, groupId: string, principalId: string): Promise<void> {
    return this.db.transaction().execute(async (trx) => {
      await lockHeads(trx, orgId, [groupId]);
      await trx
        .deleteFrom("audienceMembers")
        .where("orgId", "=", orgId)
        .where("audienceId", "=", groupId)
        .where("principalId", "=", principalId)
        .execute();
      // What the person chose to share with the group is theirs alone again.
      await trx
        .updateTable("projectChoices")
        .set({ audienceId: null })
        .where("orgId", "=", orgId)
        .where("principalId", "=", principalId)
        .where("audienceId", "=", groupId)
        .execute();
    });
  }

  async knownSubject(subject: string): Promise<{ orgId: string; removed: boolean } | null> {
    const row = await this.principals().where("subject", "=", subject).executeTakeFirst();
    return row === undefined ? null : { orgId: row.orgId, removed: row.removedAt !== null };
  }

  async addInvitation(invitation: NewInvitation): Promise<void> {
    const { orgId, id, createdBy, createdAt, expiresAt } = invitation;
    const tokenHash = toBytes(invitation.tokenHash);
    await this.db
      .insertInto("invitations")
      .values({ orgId, id, tokenHash, createdBy, createdAt, expiresAt, usedAt: null })
      .execute();
  }

  async invitation(tokenHash: string): Promise<InvitationRecord | null> {
    const row = await this.db
      .selectFrom("invitations")
      .select(["orgId", "expiresAt", "usedAt"])
      .where("tokenHash", "=", toBytes(tokenHash))
      .executeTakeFirst();
    return row ?? null;
  }

  async joinWithInvitation(
    seed: PrincipalSeed,
    everyoneId: string,
    tokenHash: string,
    at: Date,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const used = await trx
        .updateTable("invitations")
        .set({ usedAt: at })
        .where("tokenHash", "=", toBytes(tokenHash))
        .where("orgId", "=", seed.orgId)
        .where("usedAt", "is", null)
        .where("expiresAt", ">", at)
        .executeTakeFirst();
      if (used.numUpdatedRows === 0n) return false;
      await insertPrincipal(trx, seed);
      await joinEveryone(trx, seed.orgId, everyoneId, seed.principalId);
      return true;
    });
  }

  /** The organization's people, or those removed from it; ids are UUIDv7, so their order is the order they were added in. */
  private listed(orgId: string, removed: boolean): Promise<Person[]> {
    const rows = this.principals().where("orgId", "=", orgId).orderBy("id");
    return (
      removed ? rows.where("removedAt", "is not", null) : rows.where("removedAt", "is", null)
    ).execute();
  }

  people(orgId: string): Promise<Person[]> {
    return this.listed(orgId, false);
  }

  removedPeople(orgId: string): Promise<Person[]> {
    return this.listed(orgId, true);
  }

  async removePerson(orgId: string, principalId: string, at: Date): Promise<number> {
    const [id] = uuidsOf([principalId]);
    if (id === undefined) return 0;
    return this.db.transaction().execute(async (trx) => {
      const gone = await trx
        .updateTable("principals")
        .set({ removedAt: at })
        .where("orgId", "=", orgId)
        .where("id", "=", id)
        .where("removedAt", "is", null)
        .executeTakeFirst();
      if (gone.numUpdatedRows === 0n) return 0;
      const groups = await groupIdsOf(trx, orgId, id);
      await lockHeads(trx, orgId, groups);
      await trx
        .deleteFrom("audienceMembers")
        .where("orgId", "=", orgId)
        .where("principalId", "=", id)
        .execute();
      return endCredentials(trx, orgId, id, at);
    });
  }

  async rename(orgId: string, principalId: string, displayName: string): Promise<void> {
    await this.db
      .updateTable("principals")
      .set({ displayName })
      .where("orgId", "=", orgId)
      .where("id", "=", principalId)
      .execute();
  }

  async callerOf(orgId: string, principalId: string): Promise<Caller | null> {
    const [id] = uuidsOf([principalId]);
    if (id === undefined) return null;
    const principal = await this.principals()
      .where("orgId", "=", orgId)
      .where("id", "=", id)
      .executeTakeFirst();
    return this.personAs(principal, null);
  }

  async callerByTokenHash(
    tokenHash: string,
    kind: CredentialKind,
    usedAt: Date,
  ): Promise<Caller | null> {
    const credential = await this.credentialRecords()
      .where("tokenHash", "=", toBytes(tokenHash))
      .where("kind", "=", kind)
      .where("revokedAt", "is", null)
      .executeTakeFirst();
    if (credential === undefined) return null;
    await this.db
      .updateTable("credentials")
      .set({ lastUsedAt: usedAt })
      .where("orgId", "=", credential.orgId)
      .where("id", "=", credential.id)
      .where((eb) =>
        eb.or([
          eb("lastUsedAt", "is", null),
          eb("lastUsedAt", "<", new Date(usedAt.getTime() - LAST_USE_STEP_MS)),
        ]),
      )
      .execute();
    return this.byCredential(credential);
  }

  async callerOfCredential(orgId: string, credentialId: string): Promise<Caller | null> {
    const [id] = uuidsOf([credentialId]);
    if (id === undefined) return null;
    const credential = await this.credentialRecords()
      .where("orgId", "=", orgId)
      .where("id", "=", id)
      .where("revokedAt", "is", null)
      .executeTakeFirst();
    return this.byCredential(credential);
  }

  async credentialByTokenHash(tokenHash: string): Promise<Credential | null> {
    const row = await this.credentialRecords()
      .where("tokenHash", "=", toBytes(tokenHash))
      .executeTakeFirst();
    return row ?? null;
  }

  addCredential(credential: NewCredential): Promise<void> {
    return insertCredential(this.db, credential);
  }

  credentials(orgId: string, principalId: string): Promise<Credential[]> {
    return this.credentialRecords()
      .where("orgId", "=", orgId)
      .where("principalId", "=", principalId)
      .orderBy("id")
      .execute();
  }

  async replaceAgentCredentials(credential: NewCredential, at: Date): Promise<number> {
    const { orgId, principalId } = credential;
    return this.db.transaction().execute(async (trx) => {
      // Replacements of one person queue on their row, so that each ends what the one before made.
      await trx
        .selectFrom("principals")
        .select("id")
        .where("orgId", "=", orgId)
        .where("id", "=", principalId)
        .forUpdate()
        .execute();
      const ended = await endCredentials(trx, orgId, principalId, at, "agent");
      await insertCredential(trx, credential);
      return ended;
    });
  }

  async revokeCredential(orgId: string, id: string, at: Date): Promise<boolean> {
    const [known] = uuidsOf([id]);
    if (known === undefined) return false;
    const result = await this.db
      .updateTable("credentials")
      .set({ revokedAt: at })
      .where("orgId", "=", orgId)
      .where("id", "=", known)
      .where("revokedAt", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async names(
    orgId: string,
    principalIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const ids = uuidsOf(principalIds);
    if (ids.length === 0) return new Map();
    const rows = await this.principals()
      .where("orgId", "=", orgId)
      .where("id", "in", ids)
      .execute();
    return new Map(rows.map((row) => [row.id, row.displayName]));
  }
}
