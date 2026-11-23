/**
 * A server whose harnesses sign in themselves (an edition that gives the sign-in words): `setup`
 * and `doctor` say what is true of it, and its refusal of `/mcp` to a caller with no sign-in is
 * its ordinary answer, not a fault.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { connectInfo, hostProof } from "@uketsugi/server";
import { afterEach, expect, test } from "vitest";
import { doctor } from "../src/doctor.ts";
import { setup } from "../src/setup.ts";
import { account } from "./machine.ts";
import { fakeIo } from "./support.ts";

const NO_TOKEN = "hosted: your harness signs in by itself, so there is no token to paste";

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closing.splice(0).map((close) => close()));
});

/** The answers of a sign-in edition's server at the data directory's address; `/mcp` wants a sign-in. */
/** The Connect answer of an edition that gives no token: no variable and no command for it. */
function connectWithoutToken(origin: string): unknown {
  const info = { ...connectInfo(origin, null, false) } as Record<string, unknown>;
  delete info["token_env"];
  delete info["token_command"];
  return info;
}

async function signInServer(dataDir: string, origin: string, port: number): Promise<void> {
  const refusal = {
    error: { what: "Sign in.", meaning: "Your harness signs in.", next: "Sign in." },
  };
  const listener = createServer((request, response) => {
    const asked = new URL(request.url ?? "/", origin);
    void readFile(join(dataDir, "host.key"), "utf8").then((key) => {
      const answers: Record<string, unknown> = {
        "/api/host-proof": {
          proof: hostProof(key.trim(), asked.searchParams.get("challenge") ?? ""),
        },
        "/api/capabilities": {
          edition: "hosted",
          contract_version: "0",
          tools: [],
          features: {},
          degraded: [],
          dashboard: { sign_in: ["Sign in."], key_form: false, no_token: NO_TOKEN },
        },
        "/api/connect": connectWithoutToken(origin),
        "/api/projects": { projects: [] },
        "/healthz": {
          jobs: {
            waiting: 0,
            dead: 0,
            deadRecent: 0,
            deadEmbeds: 0,
            readingsFailed: 0,
            lastReadingFailure: null,
          },
        },
      };
      const known = asked.pathname in answers;
      response
        .writeHead(known ? 200 : 401, { "content-type": "application/json" })
        .end(JSON.stringify(known ? answers[asked.pathname] : refusal));
    });
  });
  await new Promise<void>((listening) => listener.listen(port, "127.0.0.1", listening));
  await writeFile(join(dataDir, "server.json"), JSON.stringify({ url: origin }));
  closing.push(async () => {
    listener.closeAllConnections();
    await new Promise((closed) => listener.close(closed));
  });
}

async function theirAccount() {
  const made = await account();
  await setup(made.io(), { ...made.options, service: false }, made.env);
  await made.free();
  await signInServer(made.dataDir, made.origin, Number(new URL(made.origin).port));
  return made;
}

test("set-up says why there is no token in the server's words, and does not take its refusal of /mcp for a fault", async () => {
  const { env, io, options } = await theirAccount();

  const report = await setup(io(), { ...options, service: false }, env);

  expect(report.failure).toBeUndefined();
  expect(report.lines.join("\n")).toContain(NO_TOKEN);
  expect(report.lines.join("\n")).not.toContain("No harness here needs a token");
  expect(report.lines.join("\n")).not.toContain("answers, but");
});

test("doctor says the same, and finds no fault in what the server asks of a harness", async () => {
  const { dataDir } = await theirAccount();

  const report = await doctor(fakeIo(), { dataDir, llm: false }, {});

  const findings = report.data["findings"] as { check: string; state: string; detail: string }[];
  expect(findings.find((finding) => finding.check === "harnesses")?.detail).toBe(NO_TOKEN);
  expect(report.lines.join("\n")).not.toContain("No harness here needs a token");
  expect(findings.filter((finding) => ["server", "store"].includes(finding.check))).toEqual([
    expect.objectContaining({ check: "server", state: "ok" }),
    expect.objectContaining({ check: "store", state: "ok" }),
  ]);
});
