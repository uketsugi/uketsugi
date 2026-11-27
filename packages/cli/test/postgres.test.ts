/**
 * A host whose store is kept on a PostgreSQL server. These cases run when a PostgreSQL server is
 * given: see testkit's `postgres.ts`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestDatabase,
  onTestServer,
  TEST_POSTGRES_URL,
  type TestDatabase,
} from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { doctor } from "../src/doctor.ts";
import { readRecord, resolveHome, writeRecord } from "../src/home.ts";
import { token } from "../src/host-verbs.ts";
import { serve } from "../src/serve.ts";
import { servingNow } from "../src/server-client.ts";
import { setup } from "../src/setup.ts";
import { backup, restore } from "../src/store-verbs.ts";
import { fakeIo, tempDir } from "./support.ts";

const LISTEN = { host: "127.0.0.1", port: "0" };

describe.runIf(TEST_POSTGRES_URL !== "")("a host set up on a PostgreSQL server", () => {
  let database: TestDatabase;
  let other: TestDatabase;
  let root: string;
  let dataDir: string;
  let first: string;

  // Setup opens the store on the server and migrates it: a hook's work.
  beforeAll(async () => {
    [database, other] = [await createTestDatabase(), await createTestDatabase()];
    root = await mkdtemp(join(tmpdir(), "ukt-postgres-"));
    dataDir = join(root, "data");
    const options = { dataDir, databaseUrl: database.url, ...LISTEN, model: false };
    await setup(fakeIo(), options, {});
    first = (await token(fakeIo(), { dataDir }, {})).lines[0] ?? "";
  });

  afterAll(async () => {
    await database.drop();
    await other.drop();
    await rm(root, { recursive: true, force: true });
  });

  test("stays on it: a verb that is not told the database again uses it, and makes no store of its own", async () => {
    const rotated = await token(fakeIo(), { dataDir, rotate: true, yes: true }, {});
    const fresh = rotated.lines[0] ?? "";
    const serving = await serve(fakeIo(), { dataDir, ...LISTEN }, {});
    const url = serving.report.data["url"] as string;
    const projects = (bearer: string) =>
      fetch(`${url}/api/projects`, { headers: { authorization: `Bearer ${bearer}` } });
    const [withOld, withNew] = [await projects(first), await projects(fresh)];
    const checked = await doctor(fakeIo(), { dataDir }, {});
    await serving.close();

    expect(rotated.data).toEqual({ token: fresh, revoked: 1 });
    expect([withOld.status, withNew.status]).toEqual([401, 200]);
    expect(serving.report.lines[1]).toBe(
      `store: PostgreSQL at ${new URL(database.url).host}/${database.name} · data directory: ${dataDir}`,
    );
    expect(checked.lines.join("\n")).toContain(
      `answers and accepts the token: 0 projects, 0 facts · PostgreSQL at ${new URL(database.url).host}/${database.name}`,
    );
    expect(existsSync(join(dataDir, "pg"))).toBe(false);
    // Where the database is kept is the settings file, private because it holds a password.
    expect((await stat(join(dataDir, "settings.json"))).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dataDir, "store.json"))).toBe(false);
    // ...and it holds the address itself: it is what the next verb reads to find the database.
    const kept = JSON.parse(await readFile(join(dataDir, "settings.json"), "utf8")) as unknown;
    expect(kept).toMatchObject({ databaseUrl: database.url });
  });

  test("a server that holds it and says nothing is found by the process its record names, there being no lock note: running, it is the server; gone, it is nothing", async () => {
    const serving = await serve(fakeIo(), { dataDir, ...LISTEN }, {});
    const home = resolveHome(dataDir, {});
    const made = await readRecord(home);
    const silent = createServer(() => undefined);
    await new Promise<void>((listening) => silent.listen(0, "127.0.0.1", listening));
    const url = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
    const child = spawn(process.execPath, ["-e", ""]);
    await new Promise((ended) => child.on("exit", ended));

    // The record a real server on PostgreSQL leaves, pointed at an address that takes the connection and is silent.
    const found = async (record: object) => {
      await writeRecord(home, { ...made, ...record } as NonNullable<typeof made>);
      return servingNow(home).catch((error: unknown) => error);
    };
    const [running, gone] = [await found({ url }), await found({ url, pid: child.pid })];
    silent.closeAllConnections();
    silent.close();
    await serving.close();

    expect(made).toMatchObject({ pid: process.pid });
    expect(existsSync(join(dataDir, "lock.owner"))).toBe(false);
    expect(running).toMatchObject({ url });
    expect(gone).toBeNull();
  });

  test("refuses a verb that copies the data directory's own store, and names PostgreSQL's tools", async () => {
    const refusal = { failure: { next: expect.stringContaining("pg_dump") as string } };

    await expect(backup({ dataDir }, {})).rejects.toMatchObject(refusal);
    await expect(
      restore(fakeIo(), join(dataDir, "token"), { dataDir, yes: true }, {}),
    ).rejects.toMatchObject(refusal);
  });

  test("refuses another database, whichever verb names it, and says how to use either", async () => {
    const elsewhere = { dataDir, databaseUrl: other.url };
    const refusal = {
      failure: {
        what: expect.stringContaining(`/${database.name}`) as string,
        next: expect.stringContaining("--data-dir") as string,
      },
    };

    await expect(serve(fakeIo(), { ...elsewhere, ...LISTEN }, {})).rejects.toMatchObject(refusal);
    await expect(
      setup(fakeIo(), { ...elsewhere, ...LISTEN, model: false }, {}),
    ).rejects.toMatchObject(refusal);
    await expect(
      token(fakeIo(), { ...elsewhere, rotate: true, yes: true }, {}),
    ).rejects.toMatchObject(refusal);
    const checked = await doctor(fakeIo(), elsewhere, {});
    expect(checked.data["findings"]).toContainEqual(
      expect.objectContaining({ check: "store", state: "fail", fix: refusal.failure.next }),
    );
  });

  test("a role that may not add the store's extensions is told what to ask a superuser for, and nothing is made", async () => {
    // A database of an ordinary role's own, as a managed server or a careful one hands out.
    const role = `ukt_plain_${database.name.slice(-12)}`;
    const mine = `${role}_db`;
    await onTestServer(`CREATE ROLE ${role} LOGIN PASSWORD 'plain'`);
    await onTestServer(`CREATE DATABASE ${mine} OWNER ${role}`);
    const url = new URL(TEST_POSTGRES_URL);
    Object.assign(url, { username: role, password: "plain", pathname: `/${mine}` });
    const made = () =>
      onTestServer(
        "select tablename from pg_tables where schemaname = 'public' union all select extname from pg_extension where extname in ('vector', 'pg_trgm')",
        mine,
      );
    const options = { dataDir: join(await tempDir(), "data"), databaseUrl: url.href, ...LISTEN };
    try {
      await expect(setup(fakeIo(), { ...options, model: false }, {})).rejects.toMatchObject({
        failure: {
          what: expect.stringContaining(
            "the role in its address may not add the extensions a store needs (pg_trgm, vector)",
          ) as string,
          meaning: "Nothing was changed.",
          next: "Have a superuser of the PostgreSQL server run this in the database, once: CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS vector; Then run this again.",
        },
      });
      expect(await made()).toEqual([]);
      // What it was told to ask for is enough: the same command then sets the host up.
      await onTestServer(
        "CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS vector;",
        mine,
      );
      const report = await setup(fakeIo(), { ...options, model: false }, {});
      expect(report.data).toMatchObject({ created: { token: true } });
    } finally {
      await onTestServer(`DROP DATABASE ${mine} WITH (FORCE)`);
      await onTestServer(`DROP ROLE ${role}`);
    }
  });

  test("takes the same database under new credentials, and keeps them for the verbs that follow", async () => {
    const renamed = new URL(database.url);
    renamed.searchParams.set("application_name", "rotated-credentials");

    const serving = await serve(fakeIo(), { dataDir, databaseUrl: renamed.href, ...LISTEN }, {});
    await serving.close();
    const again = await serve(fakeIo(), { dataDir, ...LISTEN }, {});
    await again.close();

    expect(again.report.lines[1]).toContain(`/${database.name}`);
  });

  test("a second server on the database, from another data directory, is refused in the three parts", async () => {
    const serving = await serve(fakeIo(), { dataDir, ...LISTEN }, {});
    const elsewhere = join(await tempDir(), "data");

    const second = serve(
      fakeIo(),
      { dataDir: elsewhere, databaseUrl: database.url, ...LISTEN },
      {},
    );

    await expect(second).rejects.toMatchObject({
      failure: {
        what: expect.stringContaining("is in use by another uketsugi process") as string,
        meaning: expect.stringContaining("did not start") as string,
      },
    });
    await serving.close();
  });
});
