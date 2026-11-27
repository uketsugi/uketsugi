/** What an erased account's row holds: a hash of its subject and a name that names nobody. */
import { createTestDatabase, fakeUuid, onTestServer, TEST_POSTGRES_URL } from "@uketsugi/testkit";
import { describe, expect, test } from "vitest";
import { openServerStore } from "../src/server-postgres.ts";

const SUBJECT = "https://issuer.example#a-provider-subject-4417";

describe.runIf(TEST_POSTGRES_URL !== "")("an erased account on a PostgreSQL server", () => {
  test("keeps only a hash of the subject, which is still found and refused", async () => {
    const database = await createTestDatabase();
    const store = await openServerStore({ connectionString: database.url });
    const seed = {
      subject: SUBJECT,
      displayName: "a-provider-subject-4417",
      orgId: fakeUuid(0, 1),
      principalId: fakeUuid(0, 2),
      audienceId: fakeUuid(0, 3),
    };
    await store.directory.ensurePrincipal(seed);
    await store.directory.eraseAccount(seed.orgId, seed.principalId, new Date());
    expect(await store.directory.knownSubject(SUBJECT)).toEqual({
      orgId: seed.orgId,
      removed: true,
    });
    await store.close();
    const rows = (await onTestServer("select t::text as r from principals t", database.name)) as {
      r: string;
    }[];
    const text = JSON.stringify(rows);
    expect(text).toContain("erased:");
    expect(text).toContain("deleted account");
    expect(text).not.toContain("4417");
    await database.drop();
  });
});
