/**
 * Test support: a whole server on a free port, with a store in memory, a clock the test moves,
 * a folder of dashboard files and a token, and the few ways a test reaches it.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptToken, ensureOwner } from "@uketsugi/core";
import { composeServer, openLocalPorts } from "@uketsugi/server";
import type { SignInCode } from "@uketsugi/contracts";
import { connectMcp, FakeClock, type McpTestClient } from "@uketsugi/testkit";
import { asHost, HOST_KEY, signInOnHost } from "./local-hosts.ts";

export const TOKEN = "ukt_test_token_for_the_server";
export const PROJECT = "github.com/acme/billing-service";
export const CLAIM = "Invoice webhooks retry five times with exponential backoff";
export const CITATION = "services/billing/webhooks/retry.ts:41-88@a41d07c";

export interface RunningServer {
  readonly clock: FakeClock;
  readonly url: string;
  readonly bearer: { authorization: string };
  /** An MCP client under a name of its own, so that its sessions are its own. */
  connect(name: string, protocol?: "2025-11-25"): Promise<McpTestClient>;
  /** A request with the token a harness sends. */
  api(path: string, init?: RequestInit): Promise<Response>;
  /** A JSON body posted with the token. */
  post(path: string, body: unknown): Promise<Response>;
  /** A request as whoever runs the server: with the host's own secret, as its `ukt` sends it. */
  host(path: string, init?: RequestInit): Promise<Response>;
  /** A fresh link that signs a browser in as the owner, asked for as `ukt ui` asks. */
  signInLink(): Promise<string>;
  /** A browser signed in to the dashboard as the owner: what only a person may do goes through it. */
  browser(): ReturnType<typeof signInOnHost>;
  close(): Promise<void>;
}

/** The working directory the server can read an origin for, and the remote it reads. */
const KNOWN_DIRECTORY = "/work/billing";
const originOf = (cwd: string): Promise<string | null> =>
  Promise.resolve(cwd === KNOWN_DIRECTORY ? "git@github.com:acme/billing-service.git" : null);

export async function startServer(): Promise<RunningServer> {
  const clock = new FakeClock(new Date("2026-11-13T09:00:00.000Z"));
  const webDir = await mkdtemp(join(tmpdir(), "uketsugi-web-"));
  await mkdir(join(webDir, "assets"));
  await writeFile(join(webDir, "index.html"), "<!doctype html><title>uketsugi</title>");
  await writeFile(join(webDir, "assets", "app-1a2b.js"), "export {};");
  const local = await openLocalPorts({});
  const ports = { ...local.ports, clock };
  await acceptToken(ports, local.owner, TOKEN, "test");
  const operator = {
    principalId: local.owner.principalId,
    key: HOST_KEY,
    caller: () => ensureOwner(ports),
  };
  const server = composeServer({ ports, webDir, originOf, operator });
  const { url } = await server.listen({ port: 0 });
  const clients: McpTestClient[] = [];
  const bearer = { authorization: `Bearer ${TOKEN}` };
  const api = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${url}${path}`, { ...init, headers: { ...bearer, ...init.headers } });
  return {
    clock,
    url,
    bearer,
    api,
    async connect(name, protocol) {
      const client = await connectMcp({
        url: `${url}/mcp`,
        token: TOKEN,
        client: { name, version: "1.0.0" },
        ...(protocol === undefined ? {} : { protocol }),
      });
      clients.push(client);
      return client;
    },
    post: (path, body) =>
      api(path, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    host: asHost(url),
    async signInLink() {
      const minted = await asHost(url)("/api/sign-in-codes", { method: "POST" });
      return ((await minted.json()) as SignInCode).url;
    },
    browser: () => signInOnHost(url),
    async close() {
      await Promise.all(clients.map((client) => client.close()));
      await server.close();
      await local.close();
      await rm(webDir, { recursive: true, force: true });
    },
  };
}
