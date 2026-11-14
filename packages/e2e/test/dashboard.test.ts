import { request } from "node:http";
import {
  API_CSRF_HEADER,
  FENCED_BLOCK,
  type ConnectInfo,
  type DashboardSession,
  type FactDetail,
  type FactPage,
  type ProjectList,
  type SignInCode,
} from "@uketsugi/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  CITATION,
  CLAIM,
  PROJECT,
  startServer,
  TOKEN,
  type RunningServer,
} from "./running-server.ts";

/** One HTTP exchange with headers a `fetch` will not send: Host, Origin and fetch metadata. */
function raw(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request(url, { method: "GET", headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    sent.once("error", reject);
    sent.end();
  });
}

describe("the dashboard's side of the server: sign-in, the guard, the files and /api", () => {
  let server: RunningServer;
  let url: string;
  let bearer: RunningServer["bearer"];
  const api: RunningServer["api"] = (path, init) => server.api(path, init);
  const signInLink = () => server.signInLink();

  beforeAll(async () => {
    server = await startServer();
    ({ url, bearer } = server);
    const agent = await server.connect("an-agent");
    const published = await agent.callTool("publish_fact", {
      project: PROJECT,
      claim: CLAIM,
      citations: [CITATION],
    });
    expect(published.isError, published.text).toBe(false);
  });

  afterAll(() => server.close());

  test("the one-time code signs a browser in once only, and the cookie needs its CSRF header to change anything", async () => {
    const link = await signInLink();
    const signedIn = await fetch(link, { redirect: "manual" });
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get("location")).toBe("/");
    const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(signedIn.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict$/);
    expect((await fetch(link, { redirect: "manual" })).status).toBe(401);

    const session = await fetch(`${url}/api/session`, { headers: { cookie } });
    const { person, csrf } = (await session.json()) as DashboardSession;
    expect(person).toBe("you");
    expect((await fetch(`${url}/api/session`)).status).toBe(401);
    expect((await fetch(`${url}/api/facts`)).status).toBe(401);
    expect((await fetch(`${url}/api/facts`, { headers: { cookie } })).status).toBe(200);

    const change = (headers: Record<string, string>) =>
      fetch(`${url}/api/projects`, {
        method: "POST",
        body: JSON.stringify({ slug: "onboarding" }),
        headers: { cookie, "content-type": "application/json", ...headers },
      });
    expect((await change({})).status).toBe(403);
    expect((await change({ [API_CSRF_HEADER]: "a-guess" })).status).toBe(403);
    expect((await change({ [API_CSRF_HEADER]: csrf })).status).toBe(201);

    // A browser names its page's origin on every request that changes something; a bodiless one needs it.
    const out = (headers: Record<string, string>) =>
      fetch(`${url}/api/session`, { method: "DELETE", headers: { cookie, ...headers } });
    expect((await out({ [API_CSRF_HEADER]: csrf })).status).toBe(403);
    expect((await out({ [API_CSRF_HEADER]: csrf, origin: url })).status).toBe(204);
    expect((await fetch(`${url}/api/session`, { headers: { cookie } })).status).toBe(401);
  });

  test("the host asks for a sign-in link with its own secret, and no harness token gets one", async () => {
    const minted = await server.host("/api/sign-in-codes", { method: "POST" });
    expect(minted.status).toBe(200);
    const link = (await minted.json()) as SignInCode;
    expect(link.url).toBe(`${url}/sign-in?code=${link.code}`);
    expect((await fetch(link.url, { redirect: "manual" })).status).toBe(303);
    // The token a harness holds, the host's own person's included, opens no dashboard.
    const byToken = await api("/api/sign-in-codes", { method: "POST" });
    expect(byToken.status).toBe(403);
    expect(await byToken.text()).toContain("host's own secret");
    expect((await fetch(`${url}/api/sign-in-codes`, { method: "POST" })).status).toBe(403);
    const asKey = await fetch(`${url}/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: TOKEN }),
    });
    expect(asKey.status).toBe(401);
    expect(await asKey.text()).toContain("The token a harness sends does not sign a person in");
  });

  test("a request from another origin, another host or another site's page is refused", async () => {
    const own = new URL(url);
    expect(await raw(`${url}/healthz`, {})).toBe(200);
    expect(await raw(`${url}/healthz`, { origin: url })).toBe(200);
    expect(await raw(`${url}/healthz`, { origin: "https://evil.example" })).toBe(403);
    expect(
      await raw(`${url}/healthz`, { origin: `http://127.0.0.1:${Number(own.port) + 1}` }),
    ).toBe(403);
    expect(await raw(`${url}/healthz`, { origin: "null" })).toBe(403);
    expect(await raw(`${url}/healthz`, { host: `evil.example:${own.port}` })).toBe(403);
    expect(await raw(`${url}/mcp`, { ...bearer, origin: "https://evil.example" })).toBe(403);
    expect(await raw(`${url}/api/facts`, { ...bearer, "sec-fetch-site": "cross-site" })).toBe(403);
    expect(await raw(`${url}/api/facts`, { ...bearer, "sec-fetch-site": "same-origin" })).toBe(200);
  });

  test("the dashboard's files are served with security headers, and a deep link gets the page", async () => {
    const page = await fetch(`${url}/`);
    expect(await page.text()).toContain("<title>uketsugi</title>");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");

    const asset = await fetch(`${url}/assets/app-1a2b.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    const deep = await fetch(`${url}/facts/0192`, { headers: { accept: "text/html" } });
    expect(await deep.text()).toContain("<title>uketsugi</title>");
    expect((await fetch(`${url}/assets/missing.js`)).status).toBe(404);
    expect((await api("/api/nowhere")).status).toBe(404);
  });

  test("the dashboard reads facts, one fact's history, projects, the connect page and the export", async () => {
    const all = (await (await api("/api/facts?limit=1")).json()) as FactPage;
    expect(all.facts).toHaveLength(1);
    expect(all.facts[0]).toMatchObject({ project: PROJECT, claim: CLAIM, redacted: false });
    const factId = all.facts[0]?.id ?? "";

    const found = (await (
      await api(
        `/api/facts?${new URLSearchParams({ project: PROJECT, q: "webhooks retry" }).toString()}`,
      )
    ).json()) as FactPage;
    expect(found).toMatchObject({ matched: 1, next: null, facts: [{ id: factId }] });
    expect((await api("/api/facts?q=webhooks")).status).toBe(422);
    expect((await api("/api/facts?limit=many")).status).toBe(422);

    const detail = (await (await api(`/api/facts/${factId}`)).json()) as FactDetail;
    expect(detail.fact).toMatchObject({ id: factId, author: "you", status: "unconfirmed" });
    expect(detail.history.map((entry) => entry.kind)).toContain("FactPublished");
    expect((await api("/api/facts/0192f0c0-0000-7000-8000-000000000000")).status).toBe(404);

    const projects = (await (await api("/api/projects")).json()) as ProjectList;
    expect(projects.projects.find((project) => project.key === PROJECT)).toMatchObject({
      kind: "repository",
      facts: 1,
    });

    const connect = (await (await api("/api/connect")).json()) as ConnectInfo;
    expect(connect).toMatchObject({
      mcp_url: `${url}/mcp`,
      server_name: "uketsugi",
      token_env: "UKT_TOKEN",
      block: FENCED_BLOCK,
    });
    expect(connect.harnesses.map((harness) => [harness.id, harness.add_kind])).toEqual([
      ["claude-code", "command"],
      ["antigravity", "command"],
      ["other", "url"],
    ]);
    expect(connect.harnesses.at(-1)).toMatchObject({ add: `${url}/mcp` });
    expect(JSON.stringify(connect)).not.toContain(TOKEN);

    const exported = await api(
      `/api/export?${new URLSearchParams({ project: PROJECT }).toString()}`,
    );
    expect(exported.headers.get("content-type")).toContain("text/markdown");
    const markdown = await exported.text();
    expect(markdown).toContain(`# ${PROJECT}`);
    expect(markdown).toContain(`## ${CLAIM}`);
    // A person reads the export: it says what the fact page says, not the contract's word.
    expect(markdown).toContain(`\`${CITATION}\` (can be looked up)`);
    expect(markdown).not.toContain("checkable");

    // Redacting is a person's to do: a token is refused, a signed-in browser is not.
    const byToken = await api(`/api/facts/${factId}/redact`, { method: "POST" });
    expect(byToken.status).toBe(403);
    expect(await byToken.text()).toContain("a token is not enough");
    const redacted = await (await server.browser()).post(`/api/facts/${factId}/redact`);
    expect(await redacted.json()).toEqual({ id: factId, redacted: true });
    const after = (await (await api(`/api/facts/${factId}`)).json()) as FactDetail;
    expect(after.fact).toMatchObject({ claim: null, detail: null, citations: [], redacted: true });
    expect(after.history.map((entry) => entry.kind)).toContain("FactRedacted");
    const gone = await api(`/api/export?${new URLSearchParams({ project: PROJECT }).toString()}`);
    expect(await gone.text()).not.toContain(CLAIM);
  });
});
