import { mkdir, mkdtemp, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { scopeOf, type Fact } from "@uketsugi/core";
import { PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { keepUpgradeSnapshot, lockDataDir } from "../src/data-dir.ts";
import { startEngine, upgrade, type Engine } from "../src/embedded.ts";
import {
  BACKUPS_DIR,
  backupEmbeddedStore,
  openEmbeddedStore,
  restoreEmbeddedStore,
  type EmbeddedStore,
} from "../src/index.ts";
import { connect, type Db } from "../src/codec.ts";
import { migrate, migrationState, MIGRATIONS } from "../src/migrations.ts";
import { SqlReview } from "../src/review.ts";
import { createTestDatabase, fakeUuid, onTestServer, TEST_POSTGRES_URL } from "@uketsugi/testkit";
import { publishSample, sampleOwner } from "./support/sample.ts";

const root = await mkdtemp(join(tmpdir(), "uketsugi-hosting-"));
afterAll(() => rm(root, { recursive: true, force: true }));

/** Each released version, and the first migration name it did not have. */
const RELEASES = [
  ["0.1.0", "0002"],
  ["0.2.0", "0003"],
  ["0.3.0", "0009"],
] as const;

/** A project as the schema of a release took it: the first releases dated it, and 0004 took the date out. */
async function insertProject(db: Db, below: string, org: string, key: string): Promise<void> {
  const dated = below <= "0004";
  await sql`insert into projects (org_id, key, kind ${dated ? sql`, created_at` : sql``})
    values (${org}, ${key}, 'repository' ${dated ? sql`, now()` : sql``})`.execute(db);
}

/**
 * Migrates `db` to the migrations a release had, writes a project, a fact and two flags raised
 * in the reverse of their ids' order, migrates to the newest, and checks that every row is
 * there, that a project carries no date, and that the flags still come back in the order raised.
 */
async function upgradeKeepsRows(db: Db, below: string): Promise<void> {
  const released = Object.entries(MIGRATIONS).filter(([name]) => name < below);
  await migrate(db, Object.fromEntries(released));
  const [org, audience, fact] = [fakeUuid(0, 1), fakeUuid(0, 3), fakeUuid(1, 1)];
  const [later, earlier] = [fakeUuid(2, 1), fakeUuid(2, 2)];
  await insertProject(db, below, org, "github.com/acme/api");
  await sql`
    insert into facts (org_id, id, audience_id, project, claim, status, author,
                       content_hash, claim_hash, created_at, updated_at)
    values (${org}, ${fact}, ${audience}, 'github.com/acme/api', 'Kept', 'unconfirmed',
            ${fakeUuid(0, 2)}, '\\x00', '\\x00', now(), now())`.execute(db);
  await sql`
    insert into flags (org_id, id, audience_id, fact_id, kind, raised_by_job, at)
    values (${org}, ${earlier}, ${audience}, ${fact}, 'marked_stale', 'consolidate',
            '2026-01-01T00:00:00Z'),
           (${org}, ${later}, ${audience}, ${fact}, 'possible_duplicate', 'consolidate',
            '2026-01-02T00:00:00Z')`.execute(db);
  await migrate(db);

  expect(await migrationState(db)).toMatchObject({ pending: [] });
  expect(await db.selectFrom("projects").selectAll().execute()).toEqual([
    { orgId: org, key: "github.com/acme/api", kind: "repository" },
  ]);
  expect(await db.selectFrom("facts").select(["id", "claim"]).execute()).toEqual([
    { id: fact, claim: "Kept" },
  ]);
  const flags = await new SqlReview(db).openFlags({ orgId: org, audienceIds: [audience] }, [fact]);
  expect(flags.map((flag) => flag.id)).toEqual([earlier, later]);
}

/**
 * Migrates `db` to the migrations a release had and writes what a server of several people holds
 * (a shared audience, a shared fact, a choice to share a project and one to keep another private)
 * and what a server of one holds, migrates to the newest, and checks that the shared audience is
 * the group `everyone` with each person in it, that every record is where it was and every choice
 * says what it said, and that a server of one has no group.
 */
async function upgradeKeepsSharing(db: Db, below: string): Promise<void> {
  const released = Object.entries(MIGRATIONS).filter(([name]) => name < below);
  await migrate(db, Object.fromEntries(released));
  const [org, ann, bob, annOwn, bobOwn, shared, fact] = [1, 2, 3, 4, 5, 6, 7].map((n) =>
    fakeUuid(0, n),
  ) as [string, string, string, string, string, string, string];
  const [solo, soloPerson, soloOwn] = [fakeUuid(1, 1), fakeUuid(1, 2), fakeUuid(1, 3)];
  // An organization of two with no shared audience, whose first person was removed where a release could.
  const [pair, gone, stayed] = [fakeUuid(3, 1), fakeUuid(3, 2), fakeUuid(3, 3)];
  const removable = below > "0006";
  const people = [
    [org, ann, "Ann", "local:owner"],
    [org, bob, "Bob", "local:bob"],
    [solo, soloPerson, "Sol", "local:sol"],
    [pair, gone, "Gone", "local:gone"],
    [pair, stayed, "Stayed", "local:stayed"],
  ];
  for (const [orgId, id, name, subject] of people) {
    await sql`insert into principals (org_id, id, display_name, subject)
      values (${orgId}, ${id}, ${name}, ${subject})`.execute(db);
  }
  const audiences = [
    [org, annOwn, "private", ann],
    [org, bobOwn, "private", bob],
    [org, shared, "shared", null],
    [solo, soloOwn, "private", soloPerson],
  ];
  if (removable) {
    await sql`update principals set removed_at = now() where id = ${gone}`.execute(db);
  }
  for (const [orgId, id, kind, owner] of audiences) {
    await sql`insert into audiences (org_id, id, kind, owner_id)
      values (${orgId}, ${id}, ${kind}, ${owner})`.execute(db);
    await sql`insert into audience_head (org_id, audience_id, last_seq)
      values (${orgId}, ${id}, 0)`.execute(db);
  }
  for (const key of ["github.com/acme/api", "github.com/acme/web"]) {
    await insertProject(db, below, org, key);
  }
  await sql`insert into project_choices (org_id, principal_id, project, treatment)
    values (${org}, ${ann}, 'github.com/acme/api', 'shared'),
           (${org}, ${bob}, 'github.com/acme/api', 'private'),
           (${org}, ${ann}, 'github.com/acme/web', 'private')`.execute(db);
  await sql`
    insert into facts (org_id, id, audience_id, project, claim, status, author,
                       content_hash, claim_hash, created_at, updated_at)
    values (${org}, ${fact}, ${shared}, 'github.com/acme/api', 'Shared', 'unconfirmed',
            ${ann}, '\\x00', '\\x00', now(), now())`.execute(db);
  await migrate(db);

  const kinds = await db.selectFrom("audiences").select(["id", "kind", "name"]).execute();
  expect(kinds.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
    [
      { id: annOwn, kind: "private", name: null },
      { id: bobOwn, kind: "private", name: null },
      { id: shared, kind: "group", name: "everyone" },
      { id: soloOwn, kind: "private", name: null },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );
  const members = await db
    .selectFrom("audienceMembers")
    .select(["audienceId", "principalId"])
    .execute();
  expect(members.map((row) => [row.audienceId, row.principalId]).sort()).toEqual(
    [
      [shared, ann],
      [shared, bob],
    ].sort(),
  );
  const choices = await db
    .selectFrom("projectChoices")
    .select(["principalId", "project", "audienceId"])
    .orderBy("principalId")
    .orderBy("project")
    .execute();
  expect(choices).toEqual([
    { principalId: ann, project: "github.com/acme/api", audienceId: shared },
    { principalId: ann, project: "github.com/acme/web", audienceId: null },
    { principalId: bob, project: "github.com/acme/api", audienceId: null },
  ]);
  expect(await db.selectFrom("facts").select(["id", "audienceId"]).execute()).toEqual([
    { id: fact, audienceId: shared },
  ]);
  const admins = await db
    .selectFrom("principals")
    .select("id")
    .where("administrator", "=", true)
    .orderBy("id")
    .execute();
  // The first person still there made it: a removed first person is passed over.
  expect(admins.map((row) => row.id)).toEqual([ann, soloPerson, removable ? stayed : gone].sort());
  expect(await db.selectFrom("audienceMembers").select("audienceId").execute()).toHaveLength(2);
}

describe("backup and restore", () => {
  const [from, to, file] = [join(root, "from"), join(root, "to"), join(root, "out", "one.tgz")];
  let source: EmbeddedStore;
  let scope: ReturnType<typeof scopeOf>;
  let kept: string;
  let later: string;
  let asWritten: Fact | null;

  beforeAll(async () => {
    source = await openEmbeddedStore({ dataDir: from });
    const owner = await sampleOwner(source);
    scope = scopeOf(owner);
    kept = await publishSample(source, owner, 1);
    const hash = (await source.facts.get(scope, kept))?.contentHash ?? "";
    await source.jobs.embedMissing("model-a", new Date());
    const vector = new Float32Array(384).fill(0.05);
    await source.facts.setVector(owner.orgId, kept, hash, { model: "model-a", vector });
    asWritten = await source.facts.get(scope, kept);
    // The snapshot is taken while the unit that publishes `later` is open, before it commits.
    later = await publishSample(source, owner, 2, async () => {
      expect(await backupEmbeddedStore(source, file)).toBeGreaterThan(1000);
    });
  });

  test("a copy in a fresh directory holds what was committed when the snapshot was taken, vectors included, and no more", async () => {
    await restoreEmbeddedStore({ dataDir: to, file });
    const copy = await openEmbeddedStore({ dataDir: to });
    expect(asWritten?.embedded).toBe(true);
    expect(await copy.facts.get(scope, kept)).toEqual(asWritten);
    expect(await copy.facts.get(scope, later)).toBeNull();
    await copy.close();
  });

  test("a restore that keeps the schema leaves a snapshot of an earlier release at that release's schema, which an ordinary restore brings to this one", async () => {
    const [released, snapshots] = [join(root, "released"), join(root, "released.tgz")];
    const before = Object.entries(MIGRATIONS).filter(([name]) => name < "0003");
    const engine = await startEngine(join(root, "released-source"));
    await migrate(engine.db, Object.fromEntries(before));
    await writeFile(snapshots, Buffer.from(await (await engine.snapshot()).arrayBuffer()));
    await engine.close();

    await restoreEmbeddedStore({ dataDir: released, file: snapshots, keepSchema: true });
    const kept = await startEngine(join(released, "pg"));
    const pendingKept = (await migrationState(kept.db)).pending;
    await kept.close();
    await restoreEmbeddedStore({ dataDir: released, file: snapshots });
    const moved = await startEngine(join(released, "pg"));
    const pendingMoved = (await migrationState(moved.db)).pending;
    await moved.close();

    expect(pendingKept).toEqual(Object.keys(MIGRATIONS).filter((name) => name >= "0003"));
    expect(pendingMoved).toEqual([]);
  });

  test("a restore is refused while a process owns the directory, and a file that is no snapshot replaces nothing", async () => {
    await expect(restoreEmbeddedStore({ dataDir: from, file })).rejects.toThrow(
      /in use by another uketsugi process .* Stop that process/,
    );
    await source.close();
    const noise = join(root, "out", "noise.tgz");
    await writeFile(noise, "not a snapshot");
    await expect(restoreEmbeddedStore({ dataDir: from, file: noise })).rejects.toThrow(
      /could not be restored\. The store is unchanged/,
    );
    source = await openEmbeddedStore({ dataDir: from });
    expect((await source.facts.get(scope, later))?.id).toBe(later);
    await source.close();
  });

  test("a restore replaces the store it is given", async () => {
    await restoreEmbeddedStore({ dataDir: from, file });
    const restored = await openEmbeddedStore({ dataDir: from });
    expect((await restored.facts.get(scope, kept))?.id).toBe(kept);
    expect(await restored.facts.get(scope, later)).toBeNull();
    await restored.close();
  });

  test("a restore cut short between its two renames leaves the store that was there", async () => {
    await rename(join(from, "pg"), join(from, "pg.replaced"));
    await mkdir(join(from, "pg.restoring"));
    const store = await openEmbeddedStore({ dataDir: from });
    expect((await store.facts.get(scope, kept))?.id).toBe(kept);
    expect((await readdir(from)).sort()).toEqual(["lock", "lock.owner", "pg"]);
    await store.close();
  });
});

describe("a lock left by a process that had this process's pid, as a restarted container finds", () => {
  /** A held lock whose note names this pid and whose last refresh was `ageMs` ago. */
  async function leave(dataDir: string, ageMs: number): Promise<string> {
    const lock = join(dataDir, "lock");
    await mkdir(lock, { recursive: true });
    const note = JSON.stringify({ pid: process.pid, host: hostname() });
    await writeFile(join(dataDir, "lock.owner"), note);
    const refreshed = new Date(Date.now() - ageMs);
    await utimes(lock, refreshed, refreshed);
    return lock;
  }

  test("is taken over once its holder has missed its refreshes, long before the stale time", async () => {
    const dataDir = join(root, "restarted");
    await leave(dataDir, 2500);
    const release = await lockDataDir(dataDir);
    await release();
  });

  test("is taken over though its time is ahead of the clock, as a holder killed in its first second leaves it", async () => {
    const dataDir = join(root, "killed-early");
    await leave(dataDir, -1000);
    const release = await lockDataDir(dataDir, 2000);
    await release();
  });

  test("is refused while a holder keeps refreshing it", async () => {
    const dataDir = join(root, "shared");
    const lock = await leave(dataDir, 0);
    const refresh = setInterval(() => void utimes(lock, new Date(), new Date()), 200);
    await expect(lockDataDir(dataDir, 2000)).rejects.toThrow(/in use by another uketsugi process/);
    clearInterval(refresh);
  });
});

describe("a store that a newer version opens", () => {
  const dataDir = join(root, "old");
  /** What a later version adds to today's migrations: one that makes a table. */
  const newer = {
    ...MIGRATIONS,
    "0009_hosting_test_next": {
      async up(db: Parameters<typeof migrate>[0]) {
        await sql`create table next_thing (id int)`.execute(db);
      },
    },
  };
  let kept: string;

  // The store as today's version made and left it, with one fact.
  beforeAll(async () => {
    const store = await openEmbeddedStore({ dataDir });
    kept = await publishSample(store, await sampleOwner(store), 1);
    await store.close();
  });

  test("takes the new migration with its data, and keeps a snapshot of how it was", async () => {
    const engine = await startEngine(join(dataDir, "pg"));
    await upgrade(engine, dataDir, newer);
    await upgrade(engine, dataDir, newer);
    expect(await migrationState(engine.db, newer)).toMatchObject({ pending: [] });
    expect(await engine.db.selectFrom("facts").select("id").execute()).toEqual([{ id: kept }]);
    await engine.close();
    expect(await readdir(join(dataDir, BACKUPS_DIR))).toEqual([
      "before-0009_hosting_test_next.tgz",
    ]);
  });

  test("keeps the snapshots of its three newest upgrades, and every file that is not one", async () => {
    const backups = join(dataDir, BACKUPS_DIR);
    await writeFile(join(backups, "uketsugi-20260101T000000Z.tgz"), "a person's own backup");
    for (const name of ["0009_more", "0010_again", "0011_last"])
      await keepUpgradeSnapshot(dataDir, name, new Blob(["as it was"]));
    expect((await readdir(backups)).sort()).toEqual([
      "before-0009_more.tgz",
      "before-0010_again.tgz",
      "before-0011_last.tgz",
      "uketsugi-20260101T000000Z.tgz",
    ]);
  });
});

describe("on an engine of its own, in memory", () => {
  let engine: Engine;
  beforeEach(async () => {
    engine = await startEngine();
  });
  afterEach(() => engine.close());

  test("a migration that fails changes nothing, and a store a newer version migrated is refused", async () => {
    await migrate(engine.db);
    const broken = {
      ...MIGRATIONS,
      "9999_broken": {
        async up(db: typeof engine.db) {
          await sql`alter table facts add column half_done text`.execute(db);
          await sql`select no_such_function()`.execute(db);
        },
      },
    };
    await expect(migrate(engine.db, broken)).rejects.toThrow(/Nothing was changed/);
    expect((await migrationState(engine.db, broken)).pending).toEqual(["9999_broken"]);
    const added = await sql`select 1 from information_schema.columns
      where table_name = 'facts' and column_name = 'half_done'`.execute(engine.db);
    expect(added.rows).toEqual([]);

    const newer = { ...MIGRATIONS, "9998_newer": { up: () => Promise.resolve() } };
    await migrate(engine.db, newer);
    const another =
      /^This store was made by another build of uketsugi, with a schema this build cannot read .+ Nothing was changed: the build that made it still opens it\./;
    await expect(migrate(engine.db)).rejects.toThrow(another);
    // The cause is typed, with the migration this build lacks, so that a caller can say what to do.
    await expect(migrate(engine.db)).rejects.toMatchObject({
      name: "StoreNewerError",
      missing: "9998_newer",
    });
  });

  test("a store that 0.1.0 made takes the model step's migration, and the facts it holds are an agent's", async () => {
    const released = Object.entries(MIGRATIONS).filter(([name]) => name < "0002");
    await migrate(engine.db, Object.fromEntries(released));
    const id = fakeUuid(1, 1);
    await sql`
      insert into facts (org_id, id, audience_id, project, claim, status, author,
                         content_hash, claim_hash, created_at, updated_at)
      values (${fakeUuid(0, 1)}, ${id}, ${fakeUuid(0, 3)}, 'github.com/acme/api', 'Kept', 'unconfirmed',
              ${fakeUuid(0, 2)}, '\\x00', '\\x00', now(), now())`.execute(engine.db);
    await migrate(engine.db);
    expect(await migrationState(engine.db)).toMatchObject({ pending: [] });
    const facts = await engine.db.selectFrom("facts").select(["id", "digestSession"]).execute();
    expect(facts).toEqual([{ id, digestSession: null }]);
    expect(await engine.db.selectFrom("sessionTurns").selectAll().execute()).toEqual([]);
  });

  for (const [release, below] of RELEASES) {
    test(`a store that ${release} made, holding a project, a fact and two flags, keeps them through every later migration`, async () => {
      await upgradeKeepsRows(engine.db, below);
    });

    test(`a store that ${release} made, holding a shared audience, a shared fact and choices, opens with the group everyone, its people in it and every record and choice as it was`, async () => {
      await upgradeKeepsSharing(engine.db, below);
    });
  }

  test("a store made by a build from before the first release is refused by name, in words", async () => {
    // Before 0.1.0 the one migration was edited in place, under a new name each time. A store one
    // of those edits made is refused, not opened to fail later on a column it lacks.
    await migrate(engine.db, { "0001_init": { up: () => Promise.resolve() } });
    await expect(migrate(engine.db)).rejects.toThrow(
      /^This store was made by another build of uketsugi, with a schema this build cannot read .+0001_init is missing.+ Nothing was changed/,
    );
  });
});

describe.runIf(TEST_POSTGRES_URL !== "")("on a database of its own, on a server", () => {
  for (const [release, below] of RELEASES) {
    test(`a store that ${release} made, holding a project, a fact and two flags, keeps them through every later migration`, async () => {
      const database = await createTestDatabase();
      await onTestServer("create extension vector; create extension pg_trgm", database.name);
      const db = connect(
        new PostgresDialect({ pool: new pg.Pool({ connectionString: database.url }) }),
      );
      try {
        await upgradeKeepsRows(db, below);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });

    test(`a store that ${release} made, holding a shared audience, a shared fact and choices, opens with the group everyone, its people in it and every record and choice as it was, on a server`, async () => {
      const database = await createTestDatabase();
      await onTestServer("create extension vector; create extension pg_trgm", database.name);
      const db = connect(
        new PostgresDialect({ pool: new pg.Pool({ connectionString: database.url }) }),
      );
      try {
        await upgradeKeepsSharing(db, below);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });
  }
});
