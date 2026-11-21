/**
 * A server that is busy for longer than the probe waits is still the server: `backup`, `restore`
 * and `token --rotate` find it by its process, and where nothing can say, they stop.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { hostProof } from "@uketsugi/server";
import { afterEach, describe, expect, test } from "vitest";
import { doctor } from "../src/doctor.ts";
import { token } from "../src/host-verbs.ts";
import { serve } from "../src/serve.ts";
import { backup, restore } from "../src/store-verbs.ts";
import { fakeIo, tempDir } from "./support.ts";

/** Longer than the three seconds a probe waits for "is a server there?". */
const BUSY_MS = 3_600;
const SLOW = 30_000;

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closing.splice(0).map((close) => close()));
});

/** A data directory a real server made and closed: its host secret, token and store are there, and no record. */
async function dataDirOfAServer(): Promise<string> {
  const dataDir = join(await tempDir(), "data");
  await (await serve(fakeIo(), { dataDir, host: "127.0.0.1", port: "0" }, {})).close();
  return dataDir;
}

/**
 * Something that answers as the data directory's server does, but is busy for `BUSY_MS` with the
 * first thing it is asked, and leaves the record a server leaves. `who` says what the lock and the
 * record say of its process. Returns what it was asked.
 */
async function busyServer(
  dataDir: string,
  who: {
    /** The process the store's lock names; none for a store that has no lock. A release's record names only the address. */
    lock?: { pid: number; host: string } | null;
    /** What the record says of the process, for a store with no lock. */
    record?: { pid?: number; host?: string };
    /** How many of the first requests it keeps silent, and for how long each; one, for `BUSY_MS`, left out. */
    busy?: { requests: number; ms: number };
  } = {},
): Promise<string[]> {
  const { lock = { pid: process.pid, host: hostname() }, record = {} } = who;
  const busy = who.busy ?? { requests: 1, ms: BUSY_MS };
  const note = join(dataDir, "lock.owner");
  if (lock === null) await rm(note, { force: true });
  else await writeFile(note, JSON.stringify(lock));
  const key = (await readFile(join(dataDir, "host.key"), "utf8")).trim();
  const asked: string[] = [];
  const listener = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://busy");
    asked.push(`${request.method ?? "GET"} ${path.pathname}`);
    const answers: Record<string, unknown> = {
      "/api/host-proof": { proof: hostProof(key, path.searchParams.get("challenge") ?? "") },
      "/api/capabilities": { degraded: [] },
      "/api/token/rotate": { token: "the-new-token", revoked: 1 },
      "/api/projects": { projects: [] },
    };
    setTimeout(
      () => {
        if (path.pathname === "/api/backup") response.end("a snapshot");
        else
          response
            .setHeader("content-type", "application/json")
            .end(JSON.stringify(answers[path.pathname] ?? {}));
      },
      asked.length <= busy.requests ? busy.ms : 0,
    );
  });
  await new Promise<void>((listening) => listener.listen(0, "127.0.0.1", listening));
  closing.push(async () => {
    listener.closeAllConnections();
    await new Promise((closed) => listener.close(closed));
  });
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  await writeFile(join(dataDir, "server.json"), JSON.stringify({ url, ...record }));
  return asked;
}

/** The pid of a process that has run and ended. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((ended) => child.on("exit", ended));
  return child.pid ?? 0;
}

describe("a server that is busy for longer than the probe waits", () => {
  test(
    "`ukt backup` has the server take the snapshot, and does not open the store beside it, though its record (a release 0.2.0 one) names only its address",
    async () => {
      const dataDir = await dataDirOfAServer();
      const asked = await busyServer(dataDir);

      const report = await backup({ dataDir, out: join(dataDir, "busy.tgz") }, {});

      expect(report.data["while_serving"]).toBe(true);
      expect(asked).toContain("GET /api/backup");
      expect(await readFile(join(dataDir, "busy.tgz"), "utf8")).toBe("a snapshot");
    },
    SLOW,
  );

  test(
    "`ukt restore` is refused as for a server that runs, and replaces nothing",
    async () => {
      const dataDir = await dataDirOfAServer();
      const file = join(dataDir, "before.tgz");
      await backup({ dataDir, out: file }, {});
      const before = (await stat(join(dataDir, "pg"))).mtimeMs;
      await busyServer(dataDir);

      await expect(restore(fakeIo(), file, { dataDir, yes: true }, {})).rejects.toMatchObject({
        failure: { what: expect.stringContaining("The server is running") as string },
      });
      expect((await stat(join(dataDir, "pg"))).mtimeMs).toBe(before);
    },
    SLOW,
  );

  test(
    "`ukt token --rotate` asks the server to do it, where the record and not a lock names its process",
    async () => {
      const dataDir = await dataDirOfAServer();
      // A store with no lock (on a PostgreSQL server): the record names the process.
      const asked = await busyServer(dataDir, {
        lock: null,
        record: { pid: process.pid, host: hostname() },
      });

      const report = await token(fakeIo(), { dataDir, rotate: true, yes: true }, {});

      expect(asked).toContain("POST /api/token/rotate");
      expect(report.data["token"]).toBe("the-new-token");
    },
    SLOW,
  );

  test(
    "where neither its lock nor its record says which process it is, `ukt backup` says it cannot tell and stops",
    async () => {
      const dataDir = await dataDirOfAServer();
      await busyServer(dataDir, { lock: null });

      await expect(backup({ dataDir, out: join(dataDir, "x.tgz") }, {})).rejects.toMatchObject({
        failure: { what: expect.stringContaining("did not answer in 3 seconds") as string },
      });
      await expect(stat(join(dataDir, "x.tgz"))).rejects.toThrow();
    },
    SLOW,
  );

  test(
    "where its process is gone, what holds the address is nothing of the data directory's, and the verb goes on without a server",
    async () => {
      const dataDir = await dataDirOfAServer();
      await busyServer(dataDir, { lock: { pid: await deadPid(), host: hostname() } });

      const report = await backup({ dataDir, out: join(dataDir, "gone.tgz") }, {});

      expect(report.data["while_serving"]).toBe(false);
    },
    SLOW,
  );

  test.each([
    ["the store's lock", { lock: { pid: process.pid, host: "another-host" } }],
    ["the record", { lock: null, record: { pid: process.pid, host: "another-host" } }],
  ])(
    "where %s names a process of another host, `ukt backup` cannot see it, says so and stops",
    async (_named, who) => {
      const dataDir = await dataDirOfAServer();
      await busyServer(dataDir, who);

      await expect(backup({ dataDir, out: join(dataDir, "y.tgz") }, {})).rejects.toMatchObject({
        failure: { what: expect.stringContaining("did not answer in 3 seconds") as string },
      });
    },
    SLOW,
  );

  test(
    "`ukt doctor` says the server is running and silent, not that nothing answered",
    async () => {
      const dataDir = await dataDirOfAServer();
      // Silent to the probe, and still to the request that asks what it is.
      await busyServer(dataDir, { busy: { requests: 2, ms: 10_600 } });

      const report = await doctor(fakeIo(), { dataDir, llm: false }, {});

      const finding = (report.data["findings"] as { check: string; detail: string }[]).find(
        ({ check }) => check === "server",
      );
      expect(finding?.detail).toContain("is running but did not answer in 10 seconds");
      expect(finding?.detail).not.toContain("aborted due to timeout");
    },
    SLOW,
  );
});
