/**
 * A PostgreSQL server for the cases that need a real one. They run when `UKT_TEST_POSTGRES_URL`
 * names a server with pgvector and pg_trgm and a role that may create databases, for example
 *   docker run --rm -d -e POSTGRES_PASSWORD=ukt -p 127.0.0.1:5433:5432 pgvector/pgvector:0.8.7-pg18
 *   UKT_TEST_POSTGRES_URL=postgres://postgres:ukt@127.0.0.1:5433/postgres pnpm test
 * and are skipped without it.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { eventually } from "./eventually.ts";

/** The test server's address; empty when none was given. */
export const TEST_POSTGRES_URL = process.env.UKT_TEST_POSTGRES_URL ?? "";

/**
 * Runs one statement on the test server as its own role, in its own database or in the one
 * named, and returns the rows it gave.
 */
export async function onTestServer(statement: string, database?: string): Promise<unknown[]> {
  const url = new URL(TEST_POSTGRES_URL);
  if (database !== undefined) url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  try {
    return (await client.query<Record<string, unknown>>(statement)).rows;
  } finally {
    await client.end();
  }
}

/** A database on the test server that a test has to itself. */
export interface TestDatabase {
  readonly name: string;
  /** The address of the database, as `--database-url` takes it. */
  readonly url: string;
  drop(): Promise<void>;
}

/** Makes a new, empty database on the test server. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `ukt_test_${randomUUID().replaceAll("-", "")}`;
  await onTestServer(`CREATE DATABASE ${name}`);
  const url = new URL(TEST_POSTGRES_URL);
  url.pathname = `/${name}`;
  const drop = async (): Promise<void> => {
    // A drop waits five seconds for the sessions on the database to end and is then refused ("is
    // being accessed by other users"), so on a busy machine, where a closed connection can take
    // longer than that to be ended, it fails or not by timing. Wait for the state a drop needs,
    // no session left, and drop only then. A session that never ends is a store that was not
    // closed: the wait names it, where a forced drop would hide it.
    await eventually(async () => {
      const rows = (await onTestServer(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = '${name}'`,
      )) as { n: number }[];
      if ((rows[0]?.n ?? 0) > 0) throw new Error(`${rows[0]?.n} sessions are still on ${name}`);
    });
    await onTestServer(`DROP DATABASE ${name}`);
  };
  return { name, url: url.href, drop };
}
