/**
 * Test support: the whole server as `ukt serve` runs it, on each engine, and a browser signed in
 * to its dashboard. The embedded engine always runs; PostgreSQL runs when a server is given (see
 * testkit's `postgres.ts`), on a database of the test's own.
 */
import { API_CSRF_HEADER, type DashboardSession, type SignInCode } from "@uketsugi/contracts";
import { startLocalServer, type LocalServer } from "@uketsugi/server";
import { createTestDatabase, TEST_POSTGRES_URL } from "@uketsugi/testkit";
import { describe } from "vitest";

export interface Host {
  readonly server: LocalServer;
  /** Whether this host's store can be copied while it serves. */
  readonly snapshots: boolean;
  close(): Promise<void>;
}

/** The secret of every host these tests start: what administering one takes. */
export const HOST_KEY = "ukh_test_secret_of_the_host";

/** Opens a host whose own person's harness sends `token`. */
type Open = (token: string) => Promise<Host>;

const embedded: Open = async (token) => {
  const server = await startLocalServer({ port: 0, token, hostKey: HOST_KEY, embedder: null });
  return { server, snapshots: true, close: () => server.close() };
};

const onPostgres: Open = async (token) => {
  const database = await createTestDatabase();
  const server = await startLocalServer({
    databaseUrl: database.url,
    port: 0,
    token,
    hostKey: HOST_KEY,
  });
  return {
    server,
    snapshots: false,
    async close() {
      await server.close();
      await database.drop();
    },
  };
};

/** Runs the cases on each engine, each on a server of its own. */
export function describeOnEachEngine(title: string, cases: (open: Open) => void): void {
  describe(`${title}, on the embedded engine`, () => cases(embedded));
  describe.runIf(TEST_POSTGRES_URL !== "")(`${title}, on PostgreSQL`, () => cases(onPostgres));
}

const JSON_BODY = { "content-type": "application/json" };

/** A request to a host as whoever runs it: with the host's own secret, as its `ukt` sends it. */
export const asHost =
  (url: string) =>
  (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${HOST_KEY}`, ...JSON_BODY },
    });

/** A browser with a session on the dashboard: what it reads, and what only a signed-in person may do. */
async function browserWith(url: string, status: number, setCookie: string | null) {
  const cookie = (setCookie ?? "").split(";")[0] ?? "";
  const get = (path: string) => fetch(`${url}${path}`, { headers: { cookie } });
  const session = (await (await get("/api/session")).json()) as DashboardSession;
  const post = (path: string, body: unknown = {}) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { cookie, ...JSON_BODY, [API_CSRF_HEADER]: session.csrf },
      body: JSON.stringify(body),
    });
  const del = (path: string, body?: unknown) =>
    fetch(`${url}${path}`, {
      method: "DELETE",
      headers: { cookie, ...JSON_BODY, [API_CSRF_HEADER]: session.csrf, origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const choose = (project: string, treatment: string) =>
    post("/api/projects/choice", { project, treatment });
  return { status, session, get, post, del, choose };
}

/** A browser signed in to the dashboard at `url` with a person's own dashboard key. */
export async function signIn(url: string, key: string) {
  const signedIn = await fetch(`${url}/sign-in`, {
    method: "POST",
    headers: JSON_BODY,
    body: JSON.stringify({ key }),
  });
  return browserWith(url, signedIn.status, signedIn.headers.get("set-cookie"));
}

/** A browser signed in as whoever runs the host, by a one-time link, as `ukt ui` gets one. */
export async function signInOnHost(url: string) {
  const minted = await asHost(url)("/api/sign-in-codes", { method: "POST" });
  const link = (await minted.json()) as SignInCode;
  const signedIn = await fetch(link.url, { redirect: "manual" });
  return browserWith(url, signedIn.status, signedIn.headers.get("set-cookie"));
}
