/**
 * The whole server on a PostgreSQL server, as `ukt serve --database-url` runs it: one path through
 * `/mcp` and `/api` that touches every aggregate, then a restart onto the same database. It runs
 * when a PostgreSQL server is given: see testkit's `postgres.ts`.
 */
import type {
  ActivityReport,
  FactPage,
  RulingList,
  SearchFactsResult,
  SessionNoteResult,
} from "@uketsugi/contracts";
import { startLocalServer, type LocalServer } from "@uketsugi/server";
import {
  connectMcp,
  createTestDatabase,
  FakeEmbedder,
  TEST_POSTGRES_URL,
  type McpTestClient,
  type TestDatabase,
} from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { asHost, HOST_KEY, signInOnHost } from "./local-hosts.ts";

const TOKEN = "ukt_test_token_for_the_postgres_server";
const PROJECT = "github.com/acme/billing-service";

describe.runIf(TEST_POSTGRES_URL !== "")("the server on a PostgreSQL server", () => {
  let database: TestDatabase;
  let server: LocalServer;
  let client: McpTestClient;

  const start = (embedder: FakeEmbedder | null) =>
    startLocalServer({
      databaseUrl: database.url,
      port: 0,
      token: TOKEN,
      hostKey: HOST_KEY,
      embedder,
    });
  const connect = (protocol?: "2025-11-25") =>
    connectMcp({ url: `${server.url}/mcp`, token: TOKEN, protocol });
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    });
  async function call<T = Record<string, unknown>>(tool: string, args: object, by = client) {
    const result = await by.callTool(tool, { project: PROJECT, ...args });
    expect(result.isError, result.text).toBe(false);
    return { text: result.text, content: result.structuredContent as T };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    server = await start(null);
    client = await connect();
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    await database.drop();
  });

  test("facts are published, found, confirmed and merged over /mcp, on both revisions", async () => {
    const first = await call<{ id: string }>("publish_fact", {
      claim: "Invoice webhooks retry five times with exponential backoff",
      question: "How often is an invoice webhook retried?",
      citations: ["services/billing/webhooks/retry.ts:41-88@a41d07c"],
    });
    expect(first.text).toContain("Session brief for");
    const legacy = await connect("2025-11-25");
    const found = await call<SearchFactsResult>("search_facts", { query: "webhook retry" }, legacy);
    await legacy.close();
    expect(found.content).toMatchObject({ matched: 1, shown: 1, degraded: ["no_model"] });
    expect(found.content.facts[0]).toMatchObject({ id: first.content.id, author: "you" });

    const confirmed = await call("update_fact", {
      id: first.content.id,
      confirm: { checked: "read retry.ts" },
      flag: "stale",
    });
    expect(confirmed.content).toMatchObject({ flags: ["marked_stale"] });
    const again = await call<{ id: string; similar: object[] }>("publish_fact", {
      claim: "invoice webhooks retry five times, with exponential backoff.",
      citations: ["docs/webhooks.md:3"],
    });
    expect(again.content.similar).toMatchObject([{ id: first.content.id }]);
    // The server's own worker claims the job the publish left and merges the two.
    const rulings = await vi.waitFor(async () => {
      const list = (await (await api("/api/rulings")).json()) as RulingList;
      expect(list.rulings).toHaveLength(1);
      return list.rulings;
    });
    expect(rulings[0]).toMatchObject({ decision: "merge_duplicate", actor: "consolidate" });
    const page = (await (await api("/api/facts?limit=10")).json()) as FactPage;
    expect(page.facts.map((fact) => fact.status).sort()).toEqual(["superseded", "unconfirmed"]);
    const person = await signInOnHost(server.url);
    const reverted = await person.post(`/api/rulings/${rulings[0]?.id}/revert`);
    expect(await reverted.json()).toMatchObject({ reverted: true });
  });

  test("a task is published, claimed, noted and finished under its lease", async () => {
    const published = await call<{ task: { id: string }; lease: string }>("publish_task", {
      title: "Move the retry schedule into configuration",
      claim: true,
    });
    const { id } = published.content.task;
    const noted = await call("update_task", {
      id,
      lease: published.content.lease,
      note: "Schedule read from config; tests next.",
    });
    expect(noted.content).toMatchObject({ changed: true, task: { state: "claimed" } });
    const listed = await call<{ tasks: object[]; history: object[] }>("search_tasks", { id });
    expect(listed.content.tasks).toMatchObject([
      { id, note: "Schedule read from config; tests next." },
    ]);
    expect(listed.content.history).toMatchObject([{ event: "published" }, { event: "claimed" }]);
    const done = await call("update_task", { id, lease: published.content.lease, state: "done" });
    expect(done.content).toMatchObject({ task: { state: "done" } });
  });

  test("a final note ends the session, and the dashboard's API reads what the agents did", async () => {
    const before = await call<{ session: string }>("search_facts", { query: "retry backoff" });
    const noted = await api("/api/session-notes", {
      method: "POST",
      body: JSON.stringify({ project: PROJECT, text: "Retries are documented.", final: true }),
    });
    expect((await noted.json()) as SessionNoteResult).toMatchObject({
      session: before.content.session,
      project: PROJECT,
    });
    const next = await call<{ session: string; brief: { last_session: object } }>("search_facts", {
      query: "retry backoff",
    });
    expect(next.content.session).not.toBe(before.content.session);
    expect(next.content.brief.last_session).toMatchObject({
      session: before.content.session,
      closed: true,
      note: "Retries are documented.",
    });
    const activity = (await (await api("/api/activity?days=1")).json()) as ActivityReport;
    expect(activity.clients).toContainEqual(
      expect.objectContaining({ client: "uketsugi-testkit", published: 1 }),
    );
    expect((await (await api("/api/export")).text()).split("\n")[0]).toBe(`# ${PROJECT}`);
    expect(await (await fetch(`${server.url}/healthz`)).json()).toMatchObject({ status: "ok" });
    // The host's backup route copies the embedded store only, and says what to use here.
    const backup = await asHost(server.url)("/api/backup");
    expect(backup.status).toBe(422);
    expect(await backup.json()).toMatchObject({
      error: { code: "unsupported", next: expect.stringContaining("pg_dump") as string },
    });
  });

  test("a restart with a model finds the same store and embeds what was published without one", async () => {
    await client.close();
    await server.close();
    server = await start(new FakeEmbedder());
    client = await connect();
    type Explained = SearchFactsResult & { explain: { candidates: { cosine: number | null }[] } };
    const query = "How often is an invoice webhook retried?";
    // The worker's first pass leaves a job for each fact without a vector, then runs them.
    const found = await vi.waitFor(async () => {
      const asked = await call<Explained>("search_facts", { query, explain: true });
      const cosines = asked.content.explain.candidates.map((candidate) => candidate.cosine);
      expect(cosines).toHaveLength(2);
      expect(cosines.every((cosine) => cosine !== null)).toBe(true);
      return asked;
    });
    expect(found.content).toMatchObject({ degraded: [], matched: 2 });
    const person = await signInOnHost(server.url);
    const redacted = await person.post(`/api/facts/${found.content.facts[0]?.id}/redact`);
    expect(await redacted.json()).toMatchObject({ redacted: true });
  });
});
