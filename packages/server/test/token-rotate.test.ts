/** The host's own token, replaced through the running server: the host's route alone, and the old token refused at once. */
import { afterEach, describe, expect, test } from "vitest";
import { composeServer, openLocalPorts, startLocalServer, type LocalServer } from "../src/index.ts";
import { HARNESS_REFUSALS } from "../src/errors.ts";

const HOST_KEY = `ukh_${"a".repeat(64)}`;
const closing: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

async function started(hostKey: string | undefined = HOST_KEY): Promise<LocalServer> {
  const server = await startLocalServer({ port: 0, hostKey });
  closing.push(() => server.close());
  return server;
}

const rotate = (server: LocalServer, headers: Record<string, string>) =>
  fetch(`${server.url}/api/token/rotate`, { method: "POST", headers });
const projects = (server: LocalServer, token: string) =>
  fetch(`${server.url}/api/projects`, { headers: { authorization: `Bearer ${token}` } });

describe("POST /api/token/rotate", () => {
  test("replaces the host's token: the new one works and the old one is refused at once", async () => {
    const server = await started();
    const old = server.issuedToken ?? "";

    const answered = await rotate(server, { authorization: `Bearer ${HOST_KEY}` });
    const made = (await answered.json()) as { token: string; revoked: number };

    expect(answered.status).toBe(200);
    expect(made.revoked).toBe(1);
    expect(made.token).not.toBe(old);
    expect((await projects(server, made.token)).status).toBe(200);
    expect((await projects(server, old)).status).toBe(401);
  });

  test("rotations at once leave one token that works, and each says what it ended", async () => {
    const server = await started();
    const auth = { authorization: `Bearer ${HOST_KEY}` };

    const answered = await Promise.all(Array.from({ length: 5 }, () => rotate(server, auth)));
    const made = (await Promise.all(answered.map((r) => r.json()))) as {
      token: string;
      revoked: number;
    }[];
    const working = await Promise.all(made.map(({ token }) => projects(server, token)));

    expect(working.filter((r) => r.status === 200)).toHaveLength(1);
    expect(made.reduce((sum, { revoked }) => sum + revoked, 0)).toBe(5);
  });

  test("is refused to a person's token, the host's own included, and to no credential at all", async () => {
    const server = await started();
    const harness = server.issuedToken ?? "";

    expect((await rotate(server, { authorization: `Bearer ${harness}` })).status).toBe(403);
    expect((await rotate(server, {})).status).toBe(403);
    expect((await projects(server, harness)).status).toBe(200);
  });

  test("is refused to a browser session", async () => {
    const server = await started();
    const minted = await fetch(`${server.url}/api/sign-in-codes`, {
      method: "POST",
      headers: { authorization: `Bearer ${HOST_KEY}` },
    });
    const { url } = (await minted.json()) as { url: string };
    const opened = await fetch(url, { redirect: "manual" });
    const cookie = opened.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    expect(cookie).toMatch(/^ukt_session_/);

    expect((await rotate(server, { cookie })).status).toBe(403);
    expect((await rotate(server, { cookie, "x-csrf-token": "x" })).status).toBe(403);
  });

  test("does not exist on a server with no operator", async () => {
    const local = await openLocalPorts({});
    closing.push(() => local.close());
    const server = composeServer({
      ports: local.ports,
      edition: { name: "hosted", refusals: HARNESS_REFUSALS },
    });
    closing.push(() => server.close());
    const asked = await server.fetch(
      new Request("http://127.0.0.1/api/token/rotate", {
        method: "POST",
        headers: { host: "127.0.0.1", authorization: `Bearer ${HOST_KEY}` },
      }),
    );
    // With no operator there is no such route: a request is met as one for any route unknown to it.
    expect(asked.status).toBe(401);
    expect(await asked.text()).not.toContain('"token"');
  });
});
