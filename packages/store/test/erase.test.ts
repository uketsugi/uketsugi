/** What an erased account's row holds: a hash of its subject and a name that names nobody. */
import { newSession } from "@uketsugi/core";
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

  test("takes the account's name off what its sessions cost and leaves the cost in the organization's total", async () => {
    const database = await createTestDatabase();
    const store = await openServerStore({ connectionString: database.url });
    const org = fakeUuid(0, 1);
    const person = (n: number) => ({
      subject: `https://issuer.example#spender-${n}`,
      displayName: `spender-${n}`,
      orgId: org,
      principalId: fakeUuid(0, 10 + n),
      audienceId: fakeUuid(0, 20 + n),
    });
    const [leaving, staying] = [person(1), person(2)];
    const at = new Date("2100-01-01T00:00:00Z");
    const since = new Date(at.getTime() - 60_000);
    for (const [n, who, tokens] of [
      [1, leaving, 300],
      [2, staying, 50],
    ] as const) {
      await store.directory.ensurePrincipal(who);
      const key = {
        orgId: org,
        principalId: who.principalId,
        clientName: "claude-code",
        conversationId: `c-${n}`,
        project: null,
      };
      const session = newSession(key, fakeUuid(1, n), null, at);
      await store.sessions.open(session);
      await store.sessions.spent(org, session.id, { input: tokens, output: 0 }, at);
    }
    await store.directory.eraseAccount(org, leaving.principalId, at);
    expect(await store.sessions.spentBy(org, staying.principalId, since)).toEqual({
      organization: 350,
      person: 50,
    });
    expect(await store.sessions.spentBy(org, leaving.principalId, since)).toEqual({
      organization: 350,
      person: 0,
    });
    await store.close();
    await database.drop();
  });
});
