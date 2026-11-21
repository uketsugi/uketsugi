/**
 * What an edition can add to the server: its own routes on the one listener, a session for a
 * person it has verified, a bound on the logins it holds, and its own words for a key refused.
 */
import type { CapabilityDescriptor, ConnectInfo } from "@uketsugi/contracts";
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
import { connectInfo, withoutToken } from "../src/connect.ts";
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

interface Told {
  error: { what: string; next: string };
  dashboard: CapabilityDescriptor["dashboard"];
}

/** What a sign-in link no code opens answers. */
const staleLink = async (server: UketsugiServer) =>
  (await get(server, "/sign-in?code=used")).text();

describe("the words for a browser nobody signed in", () => {
  const asked = async (server: UketsugiServer, path: string) => {
    const response = await get(server, path);
    return { status: response.status, body: (await response.json()) as Told };
  };
  const hostedWords = {
    sign_in: ["Open the dashboard's address again and sign in at the provider."],
    key_form: false,
    token_command: "hosted: command",
    token_row: "hosted: token row",
    shell_intro: "hosted: shell intro",
    shell_elsewhere: "hosted: shell elsewhere",
    token_change: "hosted: {harness} {remove}",
  };

  test("are the open edition's where the edition gives none", async () => {
    const { server } = await composed({}, true);
    const capabilities = (await asked(server, "/api/capabilities")).body;
    expect(capabilities.dashboard.key_form).toBe(true);
    expect(capabilities.dashboard.sign_in.join(" ")).toMatch(/`ukt ui`.*dashboard key/);
    expect(await staleLink(server)).toMatch(/Run `ukt ui` for a new one/);
    const session = await asked(server, "/api/session");
    expect(session.status).toBe(401);
    expect(session.body.error.next).toMatch(/dashboard key/);
  });

  test("are the edition's where it gives them, to the page and to a request nobody signed", async () => {
    const signedOut = () =>
      new ToolFailure("unauthorized", { what: "hosted: signed out", meaning: "m", next: "n" });
    const { server } = await composed({
      dashboard: hostedWords,
      signedOut,
      staleCode: "hosted: link used",
    });
    expect((await asked(server, "/api/capabilities")).body.dashboard).toEqual(hostedWords);
    const session = await asked(server, "/api/session");
    expect(session.body.error.what).toBe("hosted: signed out");
    expect(await staleLink(server)).toBe("hosted: link used");
    expect((await asked(server, "/api/facts")).body.error.what).toBe("hosted: signed out");
  });

  test("give the Connect page the edition's command for the token, and the open edition's where none is given", async () => {
    for (const [edition, command] of [
      [{ dashboard: hostedWords }, "hosted: command"],
      [{}, 'export UKT_TOKEN="$(ukt token)"'],
    ] as const) {
      const { local, server } = await composed(edition);
      await acceptToken(local.ports, local.owner, TOKEN, "test");
      const response = await server.fetch(
        new Request("http://127.0.0.1/api/connect", {
          headers: { host: "127.0.0.1", authorization: `Bearer ${TOKEN}` },
        }),
      );
      expect(((await response.json()) as { token_command: string }).token_command).toBe(command);
    }
  });
});

describe("the Connect page's lines, by edition and by caller", () => {
  const WORDS = {
    sign_in: ["Sign in at the provider."],
    key_form: false as const,
    no_token: "hosted: no token to paste",
  };
  /** Ordinary JSON: what a client reads. */
  const plain = (info: ConnectInfo): unknown => JSON.parse(JSON.stringify(info));
  /** A caller who sent a token, and one who is the machine's only person and sent none, on a real listener. */
  const callers = async (edition: Omit<Edition, "name" | "refusals">) => {
    const { local, server } = await composed(edition, false);
    await acceptToken(local.ports, local.owner, TOKEN, "test");
    const asked = await server.fetch(
      new Request("http://127.0.0.1/api/connect", {
        headers: { host: "127.0.0.1", authorization: `Bearer ${TOKEN}` },
      }),
    );
    const { url } = await server.listen({ port: 0 });
    const alone = await fetch(`${url}/api/connect`);
    return {
      url,
      tokened: (await asked.json()) as ConnectInfo,
      sole: (await alone.json()) as ConnectInfo,
    };
  };

  test("an edition that gives no words is given the open edition's, with a token for a caller who sent one and none for the machine's only person", async () => {
    const { url, tokened, sole } = await callers({});
    expect(tokened).toEqual(plain(connectInfo("http://127.0.0.1", null, true)));
    expect(sole).toEqual(plain(connectInfo(url, null, false)));
    expect(sole.needs_token).toBe(false);
    expect(sole.token_command).toBe('export UKT_TOKEN="$(ukt token)"');
  });

  test("an edition that gives the sign-in words is given the plain lines and no token's name, whoever asks", async () => {
    const { url, tokened, sole } = await callers({ dashboard: WORDS });
    expect(tokened).toEqual(plain(withoutToken(connectInfo("http://127.0.0.1", null, false))));
    expect(sole).toEqual(plain(withoutToken(connectInfo(url, null, false))));
    for (const info of [tokened, sole]) {
      expect(info.needs_token).toBe(false);
      expect(info).not.toHaveProperty("token_env");
      expect(info).not.toHaveProperty("token_command");
      expect(JSON.stringify(info.harnesses)).not.toMatch(/Bearer|UKT_TOKEN|bearer-token|configure/);
    }
  });

  test("an edition that gives the sign-in words says them in its descriptor, and no other", async () => {
    const { server } = await composed({ dashboard: WORDS });
    const body = (await (await get(server, "/api/capabilities")).json()) as Told;
    expect(body.dashboard).toEqual(WORDS);
  });
});
