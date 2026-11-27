import type { Store } from "@uketsugi/core";
import {
  createTestDatabase,
  describeModelStepConformance,
  describeGroupConformance,
  describeMoveConformance,
  describeStoreConformance,
  describeTaskStoreConformance,
  onTestServer,
  TEST_POSTGRES_URL,
  eventually,
} from "@uketsugi/testkit";
import { describe, expect, test } from "vitest";
import { openEmbeddedStore, openServerStore } from "../src/index.ts";
import { sampleOwner } from "./support/sample.ts";

describeStoreConformance("embedded PostgreSQL", { open: () => openEmbeddedStore() });
describeMoveConformance("embedded PostgreSQL", { open: () => openEmbeddedStore() });
describeGroupConformance("embedded PostgreSQL", { open: () => openEmbeddedStore() });

/** A store on a database of its own, which goes when the store closes. */
async function openOnServer(): Promise<Store & { readonly database: string }> {
  const database = await createTestDatabase();
  const store = await openServerStore({ connectionString: database.url });
  return {
    ...store,
    database: database.name,
    async close() {
      await store.close();
      await database.drop();
    },
  };
}

/** Every Store suite on a PostgreSQL server, when one is given: see testkit's `postgres.ts`. */
describe.runIf(TEST_POSTGRES_URL !== "")("on a server", () => {
  const harness = { open: () => openOnServer() };
  describeStoreConformance("PostgreSQL server", harness);
  describeMoveConformance("PostgreSQL server", harness);
  describeGroupConformance("PostgreSQL server", harness);
  describeTaskStoreConformance("PostgreSQL server", harness);
  describeModelStepConformance("PostgreSQL server", harness);

  test("a database has one owner: a second opener is refused and told why, until the first lets go", async () => {
    const database = await createTestDatabase();
    const first = await openServerStore({ connectionString: database.url });
    const second = openServerStore({ connectionString: database.url });
    await expect(second).rejects.toThrow(
      new RegExp(
        `^The PostgreSQL database \\S+/${database.name} is in use by another uketsugi process \\(connected from .+ since .+\\)\\. Stop that process`,
      ),
    );
    const { username, password } = new URL(database.url);
    await expect(second).rejects.not.toThrow(`${username}:${password}`);
    await first.close();
    const next = await openServerStore({ connectionString: database.url });
    await next.close();
    await database.drop();
  });

  test("a store whose connections the server cut carries on with new ones", async () => {
    const store = await openOnServer();
    const owner = await sampleOwner(store);
    await onTestServer(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${store.database}'`,
    );
    await eventually(async () => expect(await sampleOwner(store)).toEqual(owner));
    await store.close();
  });
});
