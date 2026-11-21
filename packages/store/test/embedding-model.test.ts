/** A store made before it recorded its vectors' model is taken as made by the model every release pinned. */
import { afterAll, beforeAll, expect, test } from "vitest";
import { sql } from "kysely";
import { fakeUuid } from "@uketsugi/testkit";
import { startEngine, type Engine } from "../src/embedded.ts";
import { migrate, MIGRATIONS } from "../src/migrations.ts";
import { SqlJobs } from "../src/jobs.ts";

const RELEASED_MODEL = "granite-small-r2@int8:1f4cf47e4ade";
const [org, audience, author] = [fakeUuid(0, 1), fakeUuid(0, 3), fakeUuid(0, 2)];

let engine: Engine;
beforeAll(async () => {
  engine = await startEngine();
  // The schema release 0.2.0 had: no table for the model.
  await migrate(
    engine.db,
    Object.fromEntries(Object.entries(MIGRATIONS).filter(([name]) => name < "0005")),
  );
});
afterAll(() => engine.close());

async function addFact(n: number, vector: string | null): Promise<string> {
  const id = fakeUuid(1, n);
  await sql`
    insert into facts (org_id, id, audience_id, project, claim, status, author, content_hash,
                       claim_hash, vector, created_at, updated_at)
    values (${org}, ${id}, ${audience}, 'github.com/acme/api', 'Fact ' || ${n}::text,
            'unconfirmed', ${author}, '\\x00', '\\x00', ${vector}::halfvec, now(), now())`.execute(
    engine.db,
  );
  return id;
}

test("a store with vectors and no recorded model is recorded as the released one and keeps them", async () => {
  const withVector = await addFact(1, `[${Array(384).fill(0.05).join(",")}]`);
  const without = await addFact(2, null);
  await migrate(engine.db);
  const rows = await sql<{ model: string }>`select model from embedding_model`.execute(engine.db);
  expect(rows.rows).toEqual([{ model: RELEASED_MODEL }]);

  // The same model opens it: nothing is lost, and only the fact that had no vector is owed one.
  expect(await new SqlJobs(engine.db).embedMissing(RELEASED_MODEL, new Date())).toBe(1);
  const kept = await sql<{ id: string; embedded: boolean }>`
    select id, vector is not null as embedded from facts order by claim`.execute(engine.db);
  expect(kept.rows).toEqual([
    { id: withVector, embedded: true },
    { id: without, embedded: false },
  ]);
});
