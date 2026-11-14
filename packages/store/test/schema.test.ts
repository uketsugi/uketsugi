import { CONTRACT_DOCUMENT } from "@uketsugi/contracts";
import {
  AUDIENCE_KINDS,
  CREDENTIAL_KINDS,
  EVENT_KINDS,
  JOB_KINDS,
  PROJECT_KINDS,
  RULING_DECISIONS,
  TREATMENTS,
} from "@uketsugi/core";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startEngine, type Engine } from "../src/embedded.ts";
import { migrate } from "../src/migrations.ts";

/** A list the tool contract declares, at a path under its shared definitions. */
function declared(...path: string[]): readonly string[] {
  const found = path.reduce<unknown>(
    (node, key) => (node as Record<string, unknown>)[key],
    CONTRACT_DOCUMENT.$defs,
  );
  return found as string[];
}

/** Every column that holds a code, with the list the code declares for it. */
const CODED: Record<string, readonly string[]> = {
  "audiences.kind": AUDIENCE_KINDS,
  "credentials.kind": CREDENTIAL_KINDS,
  "projects.kind": PROJECT_KINDS,
  "project_choices.treatment": TREATMENTS,
  "facts.status": declared("status", "enum"),
  "flags.kind": declared("flagKind", "enum"),
  "events.kind": EVENT_KINDS,
  "rulings.decision": RULING_DECISIONS,
  "outbox.kind": JOB_KINDS,
  "tasks.state": declared("taskState", "enum"),
  "task_notes.kind": declared("taskNote", "properties", "kind", "enum"),
};

let engine: Engine;
beforeAll(async () => {
  engine = await startEngine();
  await migrate(engine.db);
});
afterAll(() => engine.close());

test("each coded column's CHECK lists exactly the values the code declares", async () => {
  // A column's own CHECK is named `<table>_<column>_check`; its definition quotes each value it allows.
  const checks = await sql<{ column: string; definition: string }>`
    select t.relname || '.' || a.attname as column, pg_get_constraintdef(c.oid) as definition
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'c' and cardinality(c.conkey) = 1
      and c.conname = t.relname || '_' || a.attname || '_check'
    order by 1`.execute(engine.db);
  const inSchema = Object.fromEntries(
    checks.rows.map((row) => [
      row.column,
      [...row.definition.matchAll(/'([^']*)'::text/g)].map((match) => match[1]).sort(),
    ]),
  );
  const inCode = Object.fromEntries(
    Object.entries(CODED)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([column, values]) => [column, [...values].sort()]),
  );
  expect(inSchema).toEqual(inCode);
});
