/** What `ukt doctor` says of the jobs a server holds: those waiting, those it gave up, and a model that did not load. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApp,
  createTokenIdentity,
  createWorker,
  EmbedError,
  type CorePorts,
} from "@uketsugi/core";
import { connectInfo, hostProof, openLocalPorts } from "@uketsugi/server";
import { toolCaller } from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { doctor, type Finding } from "../src/doctor.ts";
import { serverModelFindings } from "../src/doctor-jobs.ts";
import { serve, type Serving } from "../src/serve.ts";
import { fakeIo } from "./support.ts";

describe("ukt doctor on a server that holds jobs", () => {
  let root: string;
  let dataDir: string;
  let serving: Serving | null = null;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ukt-doctor-jobs-"));
    dataDir = join(root, "data");
    // What an earlier run of the server left in its store: a reading that waits, a reading it gave up, and a
    // fact whose embedding failed for good (the model did not load).
    const local = await openLocalPorts({ dataDir });
    const broken: CorePorts = {
      ...local.ports,
      embedder: {
        model: "fake",
        dims: 384,
        embed: () => Promise.reject(new EmbedError("the model did not load", false)),
      },
    };
    const app = createApp({ ...broken, identity: createTokenIdentity(broken) });
    const client = { name: "doctor-jobs", version: null, conversationId: null };
    await toolCaller(
      app,
      local.owner,
      client,
      "github.com/acme/api",
    )("publish_fact", {
      claim: "The gateway times out after three seconds",
      citations: "src/gateway.ts:9",
    });
    // A session whose reading failed at the provider, as a refused key leaves it.
    await toolCaller(
      app,
      local.owner,
      client,
      "github.com/acme/api",
    )("search_facts", {
      query: "gateway",
    });
    const session = await local.ports.store.sessions.latest(
      local.owner.orgId,
      local.owner.principalId,
      "github.com/acme/api",
    );
    if (session === null) throw new Error("the call left no session");
    await local.ports.store.sessions.digestFailed(local.owner.orgId, session.id, {
      at: new Date(),
      reason: "the provider refused the call (status 401): the key was refused",
    });
    const worker = createWorker(broken);
    while ((await worker.drain()) > 0);
    const { jobs } = local.ports.store;
    const { orgId } = local.owner;
    const now = new Date();
    await jobs.armDigest(orgId, "00000000-0000-7000-8000-000000000001", now);
    const [given] = await jobs.claim(now, 1_000, 1);
    if (given === undefined) throw new Error("the reading was not claimed");
    await jobs.fail(given, null);
    // The session whose reading failed waits for its next look.
    await jobs.armDigest(orgId, session.id, new Date(now.getTime() + 3_600_000));
    await local.close();
    serving = await serve(fakeIo(), { dataDir, host: "127.0.0.1", port: "0" }, {});
  });

  afterAll(async () => {
    await serving?.close();
    await rm(root, { recursive: true, force: true });
  });

  test("carries the counts of waiting and given-up jobs, and a finding that some were given up", async () => {
    const report = await doctor(fakeIo(), { dataDir }, {});
    expect(report.data["jobs"]).toEqual({
      waiting: 1,
      dead: 2,
      deadRecent: 2,
      deadEmbeds: 1,
      readingsWaiting: 1,
      readingsGivenUp: 0,
      lastReadingFailure: "the provider refused the call (status 401): the key was refused",
    });
    const findings = report.data["findings"] as Finding[];
    expect(findings.find((finding) => finding.check === "jobs")).toMatchObject({
      state: "warn",
      detail: expect.stringContaining("1 waiting, 2 given up") as string,
    });
    expect(report.lines.join("\n")).toContain("2 given up");
  });

  test("says why readings wait or were given up: the provider failed or refused the call", async () => {
    const report = await doctor(fakeIo(), { dataDir }, {});
    const jobs = (report.data["findings"] as Finding[]).find((finding) => finding.check === "jobs");
    expect(jobs?.detail).toContain(
      "1 reading waits because the provider failed or refused the call: the provider refused the call (status 401): the key was refused",
    );
    expect(report.lines.join("\n")).toContain("the key was refused");
  });

  test("counts the facts whose embedding the server gave up as a finding of their own", async () => {
    const report = await doctor(fakeIo(), { dataDir }, {});
    const findings = report.data["findings"] as Finding[];
    expect(findings).toContainEqual(
      expect.objectContaining({
        check: "model",
        state: "warn",
        detail: expect.stringContaining("1 fact could not be embedded") as string,
      }),
    );
  });
});

describe("ukt doctor on a server whose embedding model did not load", () => {
  test("says so, though the server holds an embedder and the model is intact here", async () => {
    const root = await mkdtemp(join(tmpdir(), "ukt-doctor-model-"));
    const dataDir = join(root, "data");
    // A real server makes the host secret and the token; a stand-in then answers at its address.
    const first = await serve(fakeIo(), { dataDir, host: "127.0.0.1", port: "0" }, {});
    await first.close();
    const key = (await readFile(join(dataDir, "host.key"), "utf8")).trim();
    const stand = createServer((request, response) => {
      const asked = new URL(request.url ?? "/", "http://stand-in");
      const url = `http://127.0.0.1:${(stand.address() as AddressInfo).port}`;
      const answer =
        asked.pathname === "/api/host-proof"
          ? { proof: hostProof(key, asked.searchParams.get("challenge") ?? "") }
          : asked.pathname === "/api/capabilities"
            ? {
                edition: "community",
                contract_version: "0",
                tools: [],
                features: { vector: true },
                model_runners: [],
                degraded: ["embedder_unavailable"],
              }
            : asked.pathname === "/api/projects"
              ? { projects: [] }
              : asked.pathname === "/healthz"
                ? {
                    jobs: {
                      waiting: 0,
                      dead: 0,
                      deadRecent: 0,
                      deadEmbeds: 0,
                      readingsFailed: 0,
                      lastReadingFailure: null,
                    },
                  }
                : connectInfo(url, null, false);
      response.setHeader("content-type", "application/json").end(JSON.stringify(answer));
    });
    await new Promise<void>((listening) => stand.listen(0, "127.0.0.1", listening));
    try {
      const { port } = stand.address() as AddressInfo;
      await writeFile(
        join(dataDir, "server.json"),
        JSON.stringify({ url: `http://127.0.0.1:${port}` }),
      );
      const report = await doctor(fakeIo(), { dataDir, llm: false }, {});
      const findings = report.data["findings"] as Finding[];
      expect(findings).toContainEqual(
        expect.objectContaining({
          check: "model",
          state: "warn",
          detail: expect.stringContaining("the server's model did not load") as string,
        }),
      );
      expect(report.lines.join("\n")).toContain("the server's model did not load");
    } finally {
      stand.closeAllConnections();
      await new Promise((closed) => stand.close(closed));
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ukt doctor on a server that gave up a job long ago", () => {
  test("counts it and warns of nothing: a given-up job is told of for a day", async () => {
    const root = await mkdtemp(join(tmpdir(), "ukt-doctor-old-"));
    const dataDir = join(root, "data");
    const local = await openLocalPorts({ dataDir });
    const { jobs } = local.ports.store;
    const longAgo = new Date(Date.now() - 3 * 86_400_000);
    // A session whose reading was given up three days ago, with the failure kept on it as the handler leaves it.
    const app = createApp({ ...local.ports, identity: createTokenIdentity(local.ports) });
    const client = { name: "doctor-jobs", version: null, conversationId: null };
    await toolCaller(
      app,
      local.owner,
      client,
      "github.com/acme/api",
    )("search_facts", {
      query: "gateway",
    });
    const session = await local.ports.store.sessions.latest(
      local.owner.orgId,
      local.owner.principalId,
      "github.com/acme/api",
    );
    if (session === null) throw new Error("the call left no session");
    await local.ports.store.sessions.digestFailed(local.owner.orgId, session.id, {
      at: longAgo,
      reason: "the provider refused the call (status 401): the key was refused",
    });
    await jobs.armDigest(local.owner.orgId, session.id, longAgo);
    const [given] = await jobs.claim(new Date(), 1_000, 1);
    if (given === undefined) throw new Error("the reading was not claimed");
    await jobs.fail(given, null);
    await local.close();
    const serving = await serve(fakeIo(), { dataDir, host: "127.0.0.1", port: "0" }, {});
    try {
      const report = await doctor(fakeIo(), { dataDir }, {});
      const found = (report.data["findings"] as Finding[]).find((each) => each.check === "jobs");
      expect(found).toMatchObject({
        state: "ok",
        detail: "0 waiting, 1 given up (all more than a day ago)",
      });
      expect(report.data["jobs"]).toMatchObject({
        dead: 1,
        deadRecent: 0,
        readingsWaiting: 0,
        readingsGivenUp: 0,
      });
      expect(report.lines.join("\n")).not.toContain("key was refused");
    } finally {
      await serving.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ukt doctor on a server whose model is not the one that made the store's vectors", () => {
  test("says what is wrong, what it costs and what to do", () => {
    const [finding, ...others] = serverModelFindings("ukt serve", {
      degraded: ["embedder_not_the_stores"],
      jobs: null,
    });
    expect(others).toEqual([]);
    expect(finding).toMatchObject({ check: "model", state: "warn" });
    expect(finding?.detail).toContain("another server with a different embedding model");
    expect(finding?.detail).toContain("search matches words only");
    expect(finding?.fix).toContain("restart `ukt serve`");
  });
});
