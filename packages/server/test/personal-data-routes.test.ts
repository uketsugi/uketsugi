/**
 * The routes of a person's own data: the download of everything they wrote, what deleting the
 * account takes, and the deletion itself, which only an edition that offers it has and only a
 * signed-in person, not an agent's token, may do.
 */
import { API_CSRF_HEADER, LOCAL_BACKUPS, type DashboardSession } from "@uketsugi/contracts";
import type { CapabilityDescriptor, MyData } from "@uketsugi/contracts";
import { acceptToken } from "@uketsugi/core";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";
import { composeServer, openLocalPorts, type Edition } from "../src/index.ts";
import { HARNESS_REFUSALS } from "../src/errors.ts";

const TOKEN = "ukt_test_token_for_personal_data";
const BACKUPS = "Backups are kept thirty days.";
const closing: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

async function opened(offered: boolean) {
  const local = await openLocalPorts({ requireToken: true });
  closing.push(() => local.close());
  await acceptToken(local.ports, local.owner, TOKEN, "test");
  const edition: Edition = {
    name: "hosted",
    refusals: HARNESS_REFUSALS,
    routes: (host) =>
      new Hono().get("/auth/in", (c) => {
        host.openSession(c, local.owner);
        return c.text("in");
      }),
    ...(offered ? { personalData: { backups: BACKUPS } } : {}),
  };
  const server = composeServer({ ports: local.ports, edition });
  closing.push(() => server.close());
  const ask = (path: string, init: RequestInit = {}) =>
    server.fetch(
      new Request(`http://127.0.0.1${path}`, {
        ...init,
        headers: { host: "127.0.0.1", origin: "http://127.0.0.1", ...init.headers },
      }),
    );
  const cookie = (await ask("/auth/in")).headers.getSetCookie()[0]?.split(";")[0] ?? "";
  const { csrf } = (await (
    await ask("/api/session", { headers: { cookie } })
  ).json()) as DashboardSession;
  return { ask, cookie, csrf, local };
}

const asPerson = (cookie: string, csrf: string, body?: unknown): RequestInit => ({
  method: "DELETE",
  headers: { cookie, [API_CSRF_HEADER]: csrf, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("the account's routes", () => {
  test("an edition that offers deletion says so, with its words on backups; the open one does not, and has no such route", async () => {
    const offered = await opened(true);
    const said = (await (await offered.ask("/api/capabilities")).json()) as CapabilityDescriptor;
    expect(said.data).toEqual({ delete_account: true, backups: BACKUPS });
    const open = await opened(false);
    const local = (await (await open.ask("/api/capabilities")).json()) as CapabilityDescriptor;
    expect(local.data).toEqual({ delete_account: false, backups: LOCAL_BACKUPS });
    const refused = await open.ask(
      "/api/account",
      asPerson(open.cookie, open.csrf, { name: "owner" }),
    );
    expect(refused.status).toBe(404);
  });

  test("only a signed-in person deletes the account, who must send the token's CSRF header and type their name", async () => {
    const { ask, cookie, csrf, local } = await opened(true);
    const named = { name: local.owner.displayName };
    const byToken = await ask("/api/account", {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(named),
    });
    expect(byToken.status).toBe(403);
    const noCsrf = await ask("/api/account", {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(named),
    });
    expect(noCsrf.status).toBe(403);
    const wrong = await ask("/api/account", asPerson(cookie, csrf, { name: "somebody else" }));
    expect(wrong.status).toBe(422);
    const done = await ask("/api/account", asPerson(cookie, csrf, named));
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ facts: 0, tasks: 0 });
    // The session that did it ends with the account.
    expect((await ask("/api/session", { headers: { cookie } })).status).toBe(401);
  });

  test("everything a person wrote is downloaded as JSON or as Markdown, by a token or a session", async () => {
    const { ask } = await opened(true);
    const headers = { authorization: `Bearer ${TOKEN}` };
    const json = await ask("/api/export/mine", { headers });
    expect(json.headers.get("content-disposition")).toContain("uketsugi-export.json");
    expect(((await json.json()) as MyData).version).toBe(1);
    const text = await ask("/api/export/mine?format=markdown", { headers });
    expect(text.headers.get("content-type")).toContain("text/markdown");
    expect(await text.text()).toContain("Everything of yours in uketsugi");
    expect((await ask("/api/export/mine?format=xml", { headers })).status).toBe(422);
    expect((await ask("/api/account/contents", { headers })).status).toBe(200);
  });
});
