/**
 * What an edition can add to the server: its own routes on the one listener, a session for a
 * person it has verified, a bound on the logins it holds, and its own words for a key refused.
 */
import { acceptToken, ToolFailure } from "@uketsugi/core";
import { eventually } from "@uketsugi/testkit";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";
import {
  composeServer,
  navigates,
  openLocalPorts,
  type Edition,
  type Pending,
  type UketsugiServer,
} from "../src/index.ts";
import { HARNESS_REFUSALS } from "../src/errors.ts";

const TOKEN = "ukt_test_token_for_the_edition";
const closing: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

async function composed(edition: Omit<Edition, "name" | "refusals">, requireToken = true) {
  const local = await openLocalPorts({ requireToken });
  closing.push(() => local.close());
  const server = composeServer({
    ports: local.ports,
    edition: { name: "hosted", refusals: HARNESS_REFUSALS, ...edition },
  });
  closing.push(() => server.close());
  return { local, server };
}

const get = (server: UketsugiServer, path: string, host = "127.0.0.1") =>
  server.fetch(new Request(`http://${host}${path}`, { headers: { host } }));

describe("an edition's routes", () => {
  const routes = () => new Hono().get("/auth/hello", (c) => c.text("hello"));

  test("are served by the server, with its response headers", async () => {
    const { server } = await composed({ routes });
    const response = await get(server, "/auth/hello");
    expect(await response.text()).toBe("hello");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("that do not answer let the request fall through to the server's own", async () => {
    const { server } = await composed({
      routes: () => new Hono().get("*", (_c, next) => next()),
    });
    const response = await get(server, "/api/capabilities");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { edition: string }).edition).toBe("hosted");
  });

  test("meet the request guard: a foreign Host is refused", async () => {
    const { server } = await composed({ routes });
    const response = await get(server, "/auth/hello", "evil.example");
    expect(response.status).toBe(403);
    expect(await response.text()).not.toBe("hello");
  });
});

describe("a session for a person the edition verified", () => {
  test("is opened with its cookie, and the dashboard's API then knows the person", async () => {
    const { local, server } = await composed({
      routes: (host) =>
        new Hono().get("/auth/in", async (c) => {
          host.openSession(c, await local.ports.store.directory.ensurePrincipal(OWNER));
          return c.text("in");
        }),
    });
    const opened = await get(server, "/auth/in");
    const cookie = opened.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    expect(cookie).toMatch(/^ukt_session_/);
    const session = await server.fetch(
      new Request("http://127.0.0.1/api/session", { headers: { host: "127.0.0.1", cookie } }),
    );
    expect(session.status).toBe(200);
  });
});

const OWNER = {
  subject: "local:owner",
  displayName: "owner",
  orgId: "00000000-0000-4000-8000-000000000001",
  principalId: "00000000-0000-4000-8000-000000000002",
  audienceId: "00000000-0000-4000-8000-000000000003",
};

describe("the worker", () => {
  test("starts when asked, with no listener: a job a write left is tried", async () => {
    const logged: unknown[] = [];
    const embed = () => Promise.reject(new Error("the model is down"));
    const local = await openLocalPorts({ embedder: { model: "down", dims: 384, embed } });
    closing.push(() => local.close());
    await acceptToken(local.ports, local.owner, TOKEN, "test");
    const server = composeServer({ ports: local.ports, onError: (error) => logged.push(error) });
    closing.push(() => server.close());
    server.start();
    const call = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "publish_fact",
        arguments: {
          project: "github.com/acme/api",
          claim: "The gateway times out after three seconds",
          citations: "src/gateway.ts:9",
        },
      },
    };
    await server.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          host: "127.0.0.1",
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(call),
      }),
    );
    await eventually(() => expect(logged.length).toBeGreaterThan(0));
  });
});

describe("logins in progress", () => {
  test("ten thousand begun leave no more than the bound", async () => {
    let pending: Pending<number> | undefined;
    await composed({
      routes: (host) => {
        pending = host.pending<number>({ ttlMs: 600_000, max: 100 });
        return new Hono();
      },
    });
    for (let i = 0; i < 10_000; i++) pending?.put(`login-${i}`, i);
    let kept = 0;
    for (let i = 0; i < 10_000; i++) if (pending?.take(`login-${i}`) !== undefined) kept += 1;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThanOrEqual(100);
  });

  test("one that has expired is not given back", async () => {
    let pending: Pending<number> | undefined;
    await composed({
      routes: (host) => {
        pending = host.pending<number>({ ttlMs: 20, max: 10 });
        return new Hono();
      },
    });
    pending?.put("a", 1);
    pending?.put("b", 2);
    expect(pending?.take("a")).toBe(1);
    expect(pending?.take("a")).toBeUndefined();
    await new Promise((done) => setTimeout(done, 40));
    expect(pending?.take("b")).toBeUndefined();
  });
});

describe("a dashboard key the server refuses", () => {
  test("is answered in the edition's words where it gives them", async () => {
    const unknownKey = () =>
      new ToolFailure("unauthorized", { what: "hosted: no such key", meaning: "m", next: "n" });
    const { server } = await composed({ unknownKey });
    const response = await server.fetch(
      new Request("http://127.0.0.1/sign-in", {
        method: "POST",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
        body: JSON.stringify({ key: "nope" }),
      }),
    );
    expect(response.status).toBe(401);
    const said = (await response.json()) as { error: { what: string } };
    expect(said.error.what).toBe("hosted: no such key");
  });
});

describe("navigates", () => {
  test("is true for a browser's request for a page and false for anything else", () => {
    expect(navigates("text/html,application/xhtml+xml,*/*;q=0.8")).toBe(true);
    expect(navigates("application/json")).toBe(false);
    expect(navigates(undefined)).toBe(false);
  });
});
