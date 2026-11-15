import type {
  Caller,
  Credential,
  CredentialKind,
  DirectoryRepo,
  NewCredential,
  Person,
  PersonProject,
  PrincipalSeed,
  Project,
  ProjectRef,
  ProjectsRepo,
  Treatment,
} from "@uketsugi/core";
import type { Selectable } from "kysely";
import { inByteOrder, Repo, toBytes, uuidsOf, type Db } from "./codec.ts";
import type { Database } from "./schema.ts";
import { didSomething } from "./sessions.ts";

type PrincipalRow = Pick<Selectable<Database["principals"]>, "orgId" | "id" | "displayName">;

/** How often a token's last use is written: a busy token costs one write a minute, not one a call. */
const LAST_USE_STEP_MS = 60_000;

/** A principal with its private audience and that audience's head row, unless its subject is taken. */
async function insertPrincipal(db: Db, seed: PrincipalSeed): Promise<void> {
  const { orgId, principalId, audienceId, subject } = seed;
  const created = await db
    .insertInto("principals")
    .values({ orgId, id: principalId, displayName: seed.displayName, subject })
    .onConflict((conflict) => conflict.column("subject").doNothing())
    .returning("id")
    .executeTakeFirst();
  if (created === undefined) return;
  await db
    .insertInto("audiences")
    .values({ orgId, id: audienceId, kind: "private", ownerId: principalId })
    .execute();
  await db.insertInto("audienceHead").values({ orgId, audienceId, lastSeq: 0 }).execute();
}

/** An organization's shared audience with its head row, unless it has one: `audiences_one_shared`. */
async function insertShared(db: Db, orgId: string, audienceId: string): Promise<void> {
  const created = await db
    .insertInto("audiences")
    .values({ orgId, id: audienceId, kind: "shared", ownerId: null })
    .onConflict((conflict) => conflict.doNothing())
    .returning("id")
    .executeTakeFirst();
  if (created === undefined) return;
  await db.insertInto("audienceHead").values({ orgId, audienceId, lastSeq: 0 }).execute();
}

async function insertCredential(db: Db, credential: NewCredential): Promise<void> {
  const { orgId, id, principalId, kind, label, createdAt } = credential;
  const tokenHash = toBytes(credential.tokenHash);
  await db
    .insertInto("credentials")
    .values({ orgId, id, principalId, kind, label, createdAt, tokenHash })
    .execute();
}

/** Principals, their credentials and their audiences. */
export class SqlDirectory extends Repo implements DirectoryRepo {
  /**
   * The caller a principal is, signed in with a credential or with none. Their visible set is
   * their own audience and, once the organization has one, the shared audience.
   */
  private async personAs(
    principal: PrincipalRow | undefined,
    credentialId: string | null,
  ): Promise<Caller | null> {
    if (principal === undefined) return null;
    const audiences = await this.db
      .selectFrom("audiences")
      .select(["id", "kind"])
      .where("orgId", "=", principal.orgId)
      .where((eb) => eb.or([eb("ownerId", "=", principal.id), eb("kind", "=", "shared")]))
      .execute();
    const own = audiences.find((audience) => audience.kind === "private");
    if (own === undefined) return null;
    const shared = audiences.find((audience) => audience.kind === "shared")?.id ?? null;
    return {
      orgId: principal.orgId,
      principalId: principal.id,
      displayName: principal.displayName,
      credentialId,
      privateAudienceId: own.id,
      sharedAudienceId: shared,
      visibleAudienceIds: shared === null ? [own.id] : [own.id, shared],
    };
  }

  private principals() {
    return this.db.selectFrom("principals").select(["orgId", "id", "displayName"]);
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
    sharedAudienceId: string,
    credentials: readonly NewCredential[],
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await insertPrincipal(trx, seed);
      await insertShared(trx, seed.orgId, sharedAudienceId);
      for (const credential of credentials) await insertCredential(trx, credential);
    });
  }

  async people(orgId: string): Promise<Person[]> {
    // Ids are UUIDv7: their order is the order the people were added in.
    return this.principals().where("orgId", "=", orgId).orderBy("id").execute();
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

/** An organization's projects, each known by its key, and each person's choice for theirs. */
export class SqlProjects extends Repo implements ProjectsRepo {
  private of(orgId: string) {
    return this.db
      .selectFrom("projects")
      .select(["orgId", "key", "kind"])
      .where("orgId", "=", orgId);
  }

  async find(orgId: string, key: string): Promise<Project | null> {
    return (await this.of(orgId).where("key", "=", key).executeTakeFirst()) ?? null;
  }

  async ensure(orgId: string, ref: ProjectRef, at: Date): Promise<Project> {
    const known = await this.find(orgId, ref.key);
    if (known !== null) return known;
    await this.db
      .insertInto("projects")
      .values({ orgId, key: ref.key, kind: ref.kind, createdAt: at })
      .onConflict((conflict) => conflict.columns(["orgId", "key"]).doNothing())
      .execute();
    const stored = await this.find(orgId, ref.key);
    if (stored === null) throw new Error(`the project ${ref.key} could not be created`);
    return stored;
  }

  listOf(orgId: string, principalId: string): Promise<PersonProject[]> {
    return this.db
      .selectFrom("projects as p")
      .leftJoin("projectChoices as c", (join) =>
        join
          .onRef("c.orgId", "=", "p.orgId")
          .onRef("c.project", "=", "p.key")
          .on("c.principalId", "=", principalId),
      )
      .select(["p.orgId", "p.key", "p.kind"])
      .select(["c.treatment as choice", "c.displayName"])
      .where("p.orgId", "=", orgId)
      .where((eb) =>
        eb.or([
          eb("c.treatment", "is not", null),
          eb.exists(
            eb
              .selectFrom("sessions as s")
              .select("s.id")
              .whereRef("s.orgId", "=", "p.orgId")
              .whereRef("s.project", "=", "p.key")
              .where("s.principalId", "=", principalId)
              .where(didSomething("s")),
          ),
        ]),
      )
      .orderBy(inByteOrder("p.key"))
      .execute();
  }

  async choice(orgId: string, principalId: string, project: string): Promise<Treatment | null> {
    const row = await this.db
      .selectFrom("projectChoices")
      .select("treatment")
      .where("orgId", "=", orgId)
      .where("principalId", "=", principalId)
      .where("project", "=", project)
      .executeTakeFirst();
    return row?.treatment ?? null;
  }

  async choose(
    orgId: string,
    principalId: string,
    project: string,
    treatment: Treatment,
    displayName?: string,
  ): Promise<void> {
    const named = displayName === undefined ? {} : { displayName };
    await this.db
      .insertInto("projectChoices")
      .values({ orgId, principalId, project, treatment, ...named })
      .onConflict((conflict) =>
        conflict.columns(["orgId", "principalId", "project"]).doUpdateSet({ treatment, ...named }),
      )
      .execute();
  }
}
