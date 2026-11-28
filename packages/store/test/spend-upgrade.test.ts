/**
 * What the model step cost before spend named a person: it still counts in its organization's
 * total and in the server's, in a store each release made, and a spend written after the upgrade
 * names its person.
 */
import { PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { connect, type Db } from "../src/codec.ts";
import { startEngine, type Engine } from "../src/embedded.ts";
import { migrate, MIGRATIONS } from "../src/migrations.ts";
import { SqlSessions } from "../src/sessions.ts";
import { createTestDatabase, fakeUuid, onTestServer, TEST_POSTGRES_URL } from "@uketsugi/testkit";

/** Each released version, and the first migration name it did not have. */
const RELEASES = [
  ["0.1.0", "0002"],
  ["0.2.0", "0003"],
  ["0.3.0", "0009"],
] as const;

/**
 * Migrates `db` to the migrations a release had, records what the model step cost where the
 * release had a ledger of it (0.1.0 had none), migrates to the newest, and checks that the spend
 * still counts in its organization's and names no person, and that a new spend names its person.
 */
async function upgradeKeepsSpend(db: Db, below: string): Promise<void> {
  const released = Object.entries(MIGRATIONS).filter(([name]) => name < below);
  await migrate(db, Object.fromEntries(released));
  const [org, person] = [fakeUuid(0, 1), fakeUuid(0, 2)];
  const kept = below > "0002" ? 500 : 0;
  if (kept > 0) {
    await sql`insert into model_spend (org_id, at, tokens) values (${org}, now(), ${kept})`.execute(
      db,
    );
  }
  await migrate(db);

  const sessions = new SqlSessions(db);
  const since = new Date(Date.now() - 24 * 3_600_000);
  expect(await sessions.spentSince(since)).toBe(kept);
  expect(await sessions.spentBy(org, person, since)).toEqual({ organization: kept, person: 0 });
  const session = fakeUuid(0, 3);
  await sql`insert into principals (org_id, id, display_name, subject)
    values (${org}, ${person}, 'Pat', 'local:pat')`.execute(db);
  await sql`insert into sessions (org_id, id, principal_id, display_id, client_name,
                                  first_call_at, last_call_at, refused_calls, calls)
    values (${org}, ${session}, ${person}, 's-0003', 'claude-code', now(), now(), 0, 0)`.execute(
    db,
  );
  await sessions.spent(org, session, { input: 40, output: 2 }, new Date());
  expect(await sessions.spentBy(org, person, since)).toEqual({
    organization: kept + 42,
    person: 42,
  });
}

describe("on an engine of its own, in memory", () => {
  let engine: Engine;
  beforeEach(async () => {
    engine = await startEngine();
  });
  afterEach(() => engine.close());

  for (const [release, below] of RELEASES) {
    test(`a store that ${release} made keeps what the model step cost, in its organization's count, and counts each new spend for its person`, async () => {
      await upgradeKeepsSpend(engine.db, below);
    });
  }
});

describe.runIf(TEST_POSTGRES_URL !== "")("on a database of its own, on a server", () => {
  for (const [release, below] of RELEASES) {
    test(`a store that ${release} made keeps what the model step cost, in its organization's count, and counts each new spend for its person, on a server`, async () => {
      const database = await createTestDatabase();
      await onTestServer("create extension vector; create extension pg_trgm", database.name);
      const db = connect(
        new PostgresDialect({ pool: new pg.Pool({ connectionString: database.url }) }),
      );
      try {
        await upgradeKeepsSpend(db, below);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });
  }
});
