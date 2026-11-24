/**
 * The path an agent uses for what a person told it: `publish_fact` with a person citation and the
 * person's words, then `search_facts`, over the server's own MCP endpoint on the embedded store.
 * The words are in the JSON an agent reads and in the text a harness may hand its model instead.
 */
import { acceptToken } from "@uketsugi/core";
import { connectMcp, type McpTestClient } from "@uketsugi/testkit";
import { afterAll, beforeAll, expect, test } from "vitest";
import { composeServer, openLocalPorts, type UketsugiServer } from "../src/index.ts";

const TOKEN = "ukt_test_token_for_the_persons_words";
const PROJECT = "github.com/acme/api";
const WORDS = "Make the limit 40, not 60.";
/** Built at run time so that no secret-shaped literal sits in the repository. */
const GITHUB = `ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`;

let local: Awaited<ReturnType<typeof openLocalPorts>>;
let server: UketsugiServer;
let client: McpTestClient;

beforeAll(async () => {
  local = await openLocalPorts({});
  await acceptToken(local.ports, local.owner, TOKEN, "test");
  server = composeServer({ ports: local.ports });
  const { url } = await server.listen({ port: 0 });
  client = await connectMcp({ url: `${url}/mcp`, token: TOKEN });
});

afterAll(async () => {
  await client.close();
  await server.close();
  await local.close();
});

type Cited = { ref: string; kind: string; class: string; quote?: string };
const citationsOf = (content: Record<string, unknown> | undefined): Cited[] =>
  (content?.citations ?? []) as Cited[];

test("a person's words go in with the fact and come back in a publish and a search, as JSON and as text", async () => {
  const published = await client.callTool("publish_fact", {
    project: PROJECT,
    claim: "The retry limit is 40",
    citations: [{ kind: "person", who: "Priya", at: "2026-11-19", quote: `${WORDS} ${GITHUB}` }],
  });
  const stored = `${WORDS} [redacted:github-token]`;
  expect(citationsOf(published.structuredContent)[0]).toMatchObject({
    ref: "Priya, 2026-11-19",
    kind: "person",
    class: "testimony",
    quote: stored,
  });
  expect(published.structuredContent?.redacted).toBeDefined();
  expect(JSON.stringify(published.structuredContent?.redacted)).toContain("github-token");
  expect(published.text).toContain(`"${stored}"`);
  expect(published.text).not.toContain(GITHUB);

  const found = await client.callTool("search_facts", { project: PROJECT, query: "retry limit" });
  const facts = (found.structuredContent?.facts ?? []) as { citations: Cited[] }[];
  expect(facts[0]?.citations[0]).toMatchObject({ kind: "person", quote: stored });
  expect(found.text).toContain(`Priya, 2026-11-19 (testimony, a person said so): "${stored}"`);
});

test("a person citation without words comes back as it did, with none", async () => {
  const published = await client.callTool("publish_fact", {
    project: PROJECT,
    claim: "Founders are not emailed about a greeting",
    citations: [{ kind: "person", who: "Priya" }],
  });
  const [cited] = citationsOf(published.structuredContent);
  expect(cited).toMatchObject({ ref: "Priya", kind: "person", class: "testimony" });
  expect(cited).not.toHaveProperty("quote");
  expect(published.text).toContain("Priya (testimony, a person said so)");
  expect(published.text).not.toContain("Priya (testimony, a person said so):");
});
