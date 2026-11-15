import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTHING_FOUND, PROJECT_REFUSAL, TOOLS } from "@uketsugi/contracts";
import { startLocalServer, type LocalServer } from "@uketsugi/server";
import { connectMcp, type McpTestClient } from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const TOKEN = "ukt_test_token_for_the_slice";
const PROJECT = "github.com/acme/billing-service";

describe("the slice: publish, search and update over /mcp on a real server", () => {
  let dataDir: string;
  let server: LocalServer;
  let client: McpTestClient;
  let factId: string;

  const start = () => startLocalServer({ dataDir, port: 0, token: TOKEN, requireToken: true });
  const connect = () => connectMcp({ url: `${server.url}/mcp`, token: TOKEN });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "uketsugi-slice-"));
    server = await start();
    client = await connect();
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the server lists exactly the contract's tools", async () => {
    const listed = await client.listTools();
    expect(
      listed.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    ).toEqual(TOOLS);
  });

  test("a call without a bearer token is refused with 401, by a server told to ask for one", async () => {
    const response = await fetch(`${server.url}/mcp`, { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
  });

  test("a search before anything is published says nothing was found", async () => {
    const result = await client.callTool("search_facts", {
      project: PROJECT,
      query: "webhook retries",
    });
    expect(result.isError).toBe(false);
    expect(result.text.split("\n")[0]).toBe(NOTHING_FOUND);
    expect(result.structuredContent).toMatchObject({ matched: 0, shown: 0, facts: [] });
  });

  test("a fact published with a citation comes back from a search with its counts", async () => {
    const published = await client.callTool("publish_fact", {
      project: `https://${PROJECT}.git`,
      claim: "Invoice webhooks retry five times with exponential backoff",
      detail: "Handlers are idempotent on the event id.",
      question: "why are invoice webhooks delivered twice?",
      citations: ["services/billing/webhooks/retry.ts:41-88@a41d07c"],
    });
    expect(published.isError).toBe(false);
    expect(published.structuredContent).toMatchObject({
      created: true,
      status: "unconfirmed",
      project: PROJECT,
      treatment: "used here, private",
      citations: [
        {
          kind: "file",
          class: "checkable",
          ref: "services/billing/webhooks/retry.ts:41-88@a41d07c",
        },
      ],
    });
    factId = String(published.structuredContent?.id);

    const repeated = await client.callTool("publish_fact", {
      project: PROJECT,
      claim: "invoice webhooks retry five times with  exponential backoff",
      citations: "services/billing/webhooks/retry.ts:41-88",
    });
    expect(repeated.structuredContent).toMatchObject({ id: factId, created: false });

    const found = await client.callTool("search_facts", {
      project: PROJECT,
      query: "how often do webhooks retry",
    });
    expect(found.structuredContent).toMatchObject({
      matched: 1,
      shown: 1,
      degraded: ["no_model"],
      session: published.structuredContent?.session,
      facts: [{ id: factId, trust: "unreviewed", author: "you", status: "unconfirmed" }],
    });
    expect(found.text).toContain("1 matched · 1 shown");

    const elsewhere = await client.callTool("search_facts", {
      project: "github.com/acme/other",
      query: "webhooks retry",
    });
    expect(elsewhere.structuredContent).toMatchObject({ matched: 0, shown: 0 });
  });

  test("the author's update rewrites the fact in place, and a flag shows on it", async () => {
    const updated = await client.callTool("update_fact", {
      project: PROJECT,
      id: factId,
      claim: "Invoice webhooks retry seven times with exponential backoff",
      flag: "stale",
    });
    expect(updated.isError).toBe(false);
    expect(updated.structuredContent).toMatchObject({
      id: factId,
      status: "unconfirmed",
      flags: ["marked_stale"],
    });

    const byId = await client.callTool("search_facts", { project: PROJECT, id: factId });
    expect(byId.structuredContent).toMatchObject({
      shown: 1,
      facts: [
        {
          id: factId,
          claim: "Invoice webhooks retry seven times with exponential backoff",
          flags: ["marked_stale"],
        },
      ],
    });

    const missing = await client.callTool("update_fact", { project: PROJECT, id: factId });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({
      error: { code: "invalid_input", retry: false },
    });
  });

  test("a call without a project is refused with the fixed text and nothing else", async () => {
    for (const args of [{ query: "webhooks" }, { project: "billing", query: "webhooks" }]) {
      const refused = await client.callTool("search_facts", args);
      expect(refused.isError).toBe(true);
      expect(refused.text).toBe(PROJECT_REFUSAL);
      expect(refused.structuredContent).toMatchObject({ error: { code: "project_required" } });
    }
  });

  test("the older protocol revision is answered too", async () => {
    const legacy = await connectMcp({
      url: `${server.url}/mcp`,
      token: TOKEN,
      protocol: "2025-11-25",
    });
    try {
      expect((await legacy.listTools()).map((tool) => tool.name)).toEqual(
        TOOLS.map((tool) => tool.name),
      );
      const found = await legacy.callTool("search_facts", {
        project: PROJECT,
        query: "webhooks retry",
      });
      expect(found.structuredContent).toMatchObject({ shown: 1 });
    } finally {
      await legacy.close();
    }
  });

  test("the fact is still there after the server restarts", async () => {
    await client.close();
    await server.close();
    server = await start();
    client = await connect();
    const found = await client.callTool("search_facts", {
      project: PROJECT,
      query: "webhooks retry seven times",
    });
    expect(found.structuredContent).toMatchObject({ matched: 1, facts: [{ id: factId }] });
  });
});
