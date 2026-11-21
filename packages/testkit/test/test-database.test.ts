/**
 * The test server's databases are dropped when their sessions have ended, not before: a drop that
 * comes while the server is still ending a connection whose client has gone is refused ("is being
 * accessed by other users"), and whether it is depends on timing alone.
 */
import pg from "pg";
import { expect, test } from "vitest";
import { createTestDatabase, eventually, onTestServer, TEST_POSTGRES_URL } from "../src/index.ts";

const sessionsOn = async (name: string): Promise<number> => {
  const [row] = (await onTestServer(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = '${name}'`,
  )) as { n: number }[];
  return row?.n ?? 0;
};

test.runIf(TEST_POSTGRES_URL !== "")(
  "a drop asked for while the server still holds a session whose client has gone waits for it, then drops",
  async () => {
    const database = await createTestDatabase();
    const client = new pg.Client({ connectionString: database.url });
    client.on("error", () => undefined);
    await client.connect();
    // The server keeps the session for longer than a drop waits for it (five seconds) after its client has gone: a statement that
    // sleeps does not notice the socket closing, as a server so busy that it ends a connection late does not either.
    void client.query("SELECT pg_sleep(7)").catch(() => undefined);
    await eventually(async () => {
      if ((await sessionsOn(database.name)) !== 1) throw new Error("the session is not seen yet");
    });
    client.connection.stream.destroy();

    await database.drop();

    expect(
      await onTestServer(`SELECT 1 FROM pg_database WHERE datname = '${database.name}'`),
    ).toEqual([]);
  },
);
