/**
 * A server that only its own machine reaches takes its one person's programs by its address
 * alone, and nothing else that way: not a page open in that person's browser, not what a proxy
 * or a tunnel passes on, and nobody once a second person is on it, it listens beyond the machine
 * or whoever runs it asked for tokens.
 */
import type { FactPage } from "@uketsugi/contracts";
import { acceptToken, ensureOwner, invitePerson } from "@uketsugi/core";
import { composeServer, openLocalPorts, type UketsugiServer } from "@uketsugi/server";
import { connectMcp } from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HOST_KEY } from "./local-hosts.ts";
import { CITATION, CLAIM, exchange, PROJECT } from "./running-server.ts";

const TOKEN = "ukt_test_token_for_no_token";
const HOOKS = "/api/hooks/claude-code";
const JSON_BODY = { "content-type": "application/json" };

interface Host {
  readonly url: string;
  readonly local: Awaited<ReturnType<typeof openLocalPorts>>;
  readonly server: UketsugiServer;
  close(): Promise<void>;
}

/** A server of one person who also holds a token, listening as `ukt serve` does unless told otherwise. */
async function host(
  options: { requireToken?: boolean; allowedHosts?: string[]; host?: string } = {},
): Promise<Host> {
  const local = await openLocalPorts({ requireToken: options.requireToken });
  await acceptToken(local.ports, local.owner, TOKEN, "test");
  const operator = {
    principalId: local.owner.principalId,
    key: HOST_KEY,
    caller: () => ensureOwner(local.ports),
  };
  const server = composeServer({
    ports: local.ports,
    allowedHosts: options.allowedHosts,
    operator,
  });
  const { url } = await server.listen({ host: options.host, port: 0 });
  return {
    url,
    local,
    server,
    async close() {
      await server.close();
      await local.close();
    },
  };
}

/** What a refusal says first. */
const whatOf = (text: string): string =>
  (JSON.parse(text) as { error: { what: string } }).error.what;

const REACHED =
  "This harness sent no token, and this server takes one from whatever reaches it from beyond its own machine.";
const ASKS = "This harness sent no token, and this server asks every caller for one.";

/** A tool call as a harness posts it, to send as some other kind of body. */
const PUBLISH = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "publish_fact",
    arguments: { project: PROJECT, claim: "Written by a page", citations: [CITATION] },
  },
});
const STOP = JSON.stringify({
  hook_event_name: "Stop",
  session_id: "c-page",
  last_assistant_message: "Written by a page.",
});

describe("one person on their own machine, with no token", () => {
  let one: Host;
  const facts = async (): Promise<FactPage> =>
    (await (await fetch(`${one.url}/api/facts`)).json()) as FactPage;

  beforeAll(async () => {
    one = await host();
  });
  afterAll(() => one.close());

  test("/mcp and every route a token reaches answer", async () => {
    const client = await connectMcp({ url: `${one.url}/mcp` });
    expect(await client.listTools()).toHaveLength(7);
    const published = await client.callTool("publish_fact", {
      project: PROJECT,
      claim: CLAIM,
      citations: [CITATION],
    });
    expect(published.isError, published.text).toBe(false);
    await client.close();
    expect((await facts()).facts.map((fact) => fact.claim)).toEqual([CLAIM]);
    const reads = ["/api/tasks", "/api/projects", "/api/rulings", "/api/connect", "/api/activity"];
    for (const path of [...reads, `/api/export?project=${PROJECT}`]) {
      expect((await fetch(`${one.url}${path}`)).status, path).toBe(200);
    }
    const start = await fetch(`${one.url}${HOOKS}`, {
      method: "POST",
      headers: JSON_BODY,
      body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "c-none" }),
    });
    expect(start.status).toBe(200);
    expect(await start.json()).toHaveProperty("hookSpecificOutput.additionalContext");
  });

  test("a header that holds no token is none, a token the server knows still works, and one it does not is refused", async () => {
    const as = (authorization: string) =>
      fetch(`${one.url}/api/facts`, { headers: { authorization } });
    expect((await as("Bearer")).status).toBe(200);
    expect((await as("Bearer ")).status).toBe(200);
    expect((await as(`Bearer ${TOKEN}`)).status).toBe(200);
    expect((await as("Bearer ukt_a_token_this_server_never_issued")).status).toBe(401);
    const mcp = await fetch(`${one.url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer ukt_unknown" },
    });
    expect(mcp.status).toBe(401);
    expect(whatOf(await mcp.text())).toBe("This server does not know the token this harness sent.");
  });

  test("what needs the host's secret or a signed-in browser still does", async () => {
    expect((await fetch(`${one.url}/api/people`)).status).toBe(403);
    expect((await fetch(`${one.url}/api/backup`)).status).toBe(403);
    expect((await fetch(`${one.url}/api/sign-in-codes`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${one.url}/api/session`)).status).toBe(401);
    for (const path of ["/api/projects", "/api/projects/choice", "/api/facts/x/redact"]) {
      const change = await fetch(`${one.url}${path}`, {
        method: "POST",
        headers: JSON_BODY,
        body: "{}",
      });
      expect(change.status, path).toBe(403);
    }
  });

  test("a page in the person's browser can neither read nor write", async () => {
    const { port } = new URL(one.url);
    const before = await facts();
    const evil = { origin: "https://evil.example" };
    const form = { "content-type": "application/x-www-form-urlencoded" };
    const text = { "content-type": "text/plain" };
    const refused = async (path: string, sent: Parameters<typeof exchange>[1], why: string) => {
      const answer = await exchange(`${one.url}${path}`, sent);
      expect(answer.status, `${why}: ${path}`).toBe(403);
      expect(answer.headers["access-control-allow-origin"], why).toBeUndefined();
    };
    for (const path of ["/mcp", "/api/facts", HOOKS]) {
      // A name of the page's own, pointed at this machine.
      await refused(path, { headers: { host: `evil.example:${port}` } }, "rebound name");
      // A request the browser asks about first, and the asking itself.
      const ask = { ...evil, "access-control-request-method": "POST" };
      await refused(path, { method: "OPTIONS", headers: ask }, "preflight");
      await refused(path, { method: "POST", headers: { ...evil, ...JSON_BODY } }, "fetch");
      // What a page sends without asking: a form, or a fetch of plain text.
      for (const [kind, body] of [
        [text, path === HOOKS ? STOP : PUBLISH],
        [form, "a=b"],
      ] as const) {
        await refused(path, { method: "POST", headers: { ...evil, ...kind }, body }, "simple");
        const marked = { "sec-fetch-site": "cross-site", ...kind };
        await refused(path, { method: "POST", headers: marked, body }, "fetch metadata");
      }
      // Another program's page on this machine, a page with no origin, an image or a script tag.
      const neighbour = { origin: `http://127.0.0.1:${Number(port) + 1}` };
      await refused(path, { headers: neighbour }, "another port");
      await refused(path, { headers: { origin: "null" } }, "no origin");
      await refused(path, { headers: { "sec-fetch-site": "same-site" } }, "same site");
      await refused(path, { headers: { "sec-fetch-site": "cross-site" } }, "tag");
    }
    expect(await facts()).toEqual(before);
  });

  test("a browser too old to mark a request cannot write with what a page sends unasked, and no GET writes", async () => {
    const before = await facts();
    const text = { "content-type": "text/plain" };
    const form = { "content-type": "application/x-www-form-urlencoded" };
    for (const headers of [text, form, {}]) {
      const call = await exchange(`${one.url}/mcp`, { method: "POST", headers, body: PUBLISH });
      expect(call.status, JSON.stringify(headers)).toBeGreaterThanOrEqual(400);
      const hook = await exchange(`${one.url}${HOOKS}`, { method: "POST", headers, body: STOP });
      expect(hook.status, JSON.stringify(headers)).toBeGreaterThanOrEqual(400);
    }
    // A GET such a browser sends is answered as a local program's is: it can change nothing, and
    // the page cannot read the answer, which names no origin that may.
    const read = await exchange(`${one.url}/api/facts`);
    expect(read.status).toBe(200);
    expect(read.headers["access-control-allow-origin"]).toBeUndefined();
    expect(read.headers["x-content-type-options"]).toBe("nosniff");
    expect((await exchange(`${one.url}/mcp`)).status).toBeGreaterThanOrEqual(400);
    expect((await exchange(`${one.url}${HOOKS}`)).status).toBeGreaterThanOrEqual(400);
    expect(await facts()).toEqual(before);
    const activity = (await (await fetch(`${one.url}/api/activity`)).json()) as {
      sessions: { conversation?: string }[];
    };
    expect(JSON.stringify(activity)).not.toContain("c-page");
  });

  test("a request that says it was passed on is not this machine's own", async () => {
    const passed = {
      "x-forwarded-for": "203.0.113.9",
      "x-forwarded-host": "memory.example.com",
      "x-forwarded-proto": "https",
      forwarded: "for=203.0.113.9",
      via: "1.1 proxy",
      "x-real-ip": "203.0.113.9",
    };
    for (const [name, value] of Object.entries(passed)) {
      const answer = await exchange(`${one.url}/mcp`, {
        method: "POST",
        headers: { [name]: value },
      });
      expect(answer.status, name).toBe(401);
      expect(whatOf(answer.text), name).toBe(REACHED);
      const signed = { [name]: value, authorization: `Bearer ${TOKEN}` };
      expect((await exchange(`${one.url}/api/facts`, { headers: signed })).status, name).toBe(200);
    }
    // A request with no connection behind it, as another process of the host might hand one over.
    const named = { headers: { host: new URL(one.url).host } };
    const handed = await one.server.fetch(new Request(`${one.url}/api/facts`, named));
    expect(handed.status).toBe(401);
  });
});

describe("a server that takes no caller without a token", () => {
  const none = async (served: Host): Promise<{ status: number; what: string }> => {
    const answer = await fetch(`${served.url}/mcp`, { method: "POST", body: "{}" });
    expect(answer.headers.get("www-authenticate")).toBe("Bearer");
    return { status: answer.status, what: whatOf(await answer.text()) };
  };
  const signed = async (served: Host, token = TOKEN): Promise<number> =>
    (await fetch(`${served.url}/api/facts`, { headers: { authorization: `Bearer ${token}` } }))
      .status;

  test("one that a second person is on, from the moment they are added", async () => {
    const shared = await host();
    try {
      expect((await fetch(`${shared.url}/api/facts`)).status).toBe(200);
      const invited = await invitePerson(shared.local.ports, shared.local.owner, {
        name: "bob",
        operator_name: "ann",
      });
      expect(await none(shared)).toEqual({ status: 401, what: ASKS });
      expect((await fetch(`${shared.url}/api/facts`)).status).toBe(401);
      expect(await signed(shared)).toBe(200);
      expect(await signed(shared, invited.issued[0]?.secret)).toBe(200);
    } finally {
      await shared.close();
    }
  });

  test("one whose host asked every caller for a token", async () => {
    const strict = await host({ requireToken: true });
    try {
      expect(await none(strict)).toEqual({ status: 401, what: ASKS });
      expect(await signed(strict)).toBe(200);
    } finally {
      await strict.close();
    }
  });

  test("one that listens beyond its own machine, or answers to a name of its own", async () => {
    for (const beyond of [{ host: "0.0.0.0" }, { allowedHosts: ["memory.example.com"] }]) {
      const open = await host(beyond);
      try {
        expect(await none(open), JSON.stringify(beyond)).toEqual({ status: 401, what: REACHED });
        expect(await signed(open)).toBe(200);
      } finally {
        await open.close();
      }
    }
  });
});
