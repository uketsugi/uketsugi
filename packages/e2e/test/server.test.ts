import {
  BLOCK_TEXT,
  CONTRACT_VERSION,
  FENCED_BLOCK,
  PROJECT_REFUSAL,
  PROMPT_DESCRIPTIONS,
  SETUP_FOLLOW_TEXT,
  setupPromptText,
  TOOLS,
  type ActivityReport,
  type Brief,
  type CapabilityDescriptor,
} from "@uketsugi/contracts";
import { SESSION_IDLE_MS } from "@uketsugi/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { McpCallResult } from "@uketsugi/testkit";
import { CITATION, CLAIM, PROJECT, startServer, type RunningServer } from "./running-server.ts";

describe("the server over /mcp: the contract, sessions and the brief", () => {
  let server: RunningServer;
  let url: string;
  const clock = () => server.clock;
  const connect: RunningServer["connect"] = (name, protocol) => server.connect(name, protocol);
  const api: RunningServer["api"] = (path, init) => server.api(path, init);
  const post: RunningServer["post"] = (path, body) => server.post(path, body);
  const briefOf = (content: Record<string, unknown> | undefined) =>
    content?.brief as Brief | undefined;

  beforeAll(async () => {
    server = await startServer();
    url = server.url;
  });

  afterAll(() => server.close());

  test("tools/list is the contract's served tools and prompts/list its two commands, on both revisions", async () => {
    for (const protocol of [undefined, "2025-11-25"] as const) {
      const client = await connect("contract-check", protocol);
      const tools = await client.listTools();
      expect(
        tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      ).toEqual(TOOLS);
      expect(await client.listPrompts()).toEqual([
        { name: "activate", description: PROMPT_DESCRIPTIONS.activate },
        { name: "setup", description: PROMPT_DESCRIPTIONS.setup },
      ]);
      expect(await client.getPrompt("activate")).toBe(BLOCK_TEXT);
      // A client the server does not know is not told another harness's file: its agent names its own.
      const setup = await client.getPrompt("setup");
      expect(setup).toBe(`${setupPromptText(null)}\n${SETUP_FOLLOW_TEXT}`);
      expect(setup).toContain("my user-level instruction file, creating");
      expect(setup).toContain(FENCED_BLOCK);
    }
    // Claude Code's file is in the folder CLAUDE_CONFIG_DIR names where that is set, and under
    // whichever home it runs in: its agent is given the command that prints the path, to run,
    // and is not left to work the path out.
    const claude = await connect("claude-code");
    expect(await claude.getPrompt("setup")).toBe(
      `Add the block below at the very top of my user-level instruction file (run this command and use the path it prints: echo "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/CLAUDE.md"), creating the file if it does not exist. Keep everything already in the file, unchanged, below it. Do not change the block's text.\n\n${FENCED_BLOCK}\n${SETUP_FOLLOW_TEXT}`,
    );
  });

  test("the capability descriptor says what is served, to anyone who asks", async () => {
    const response = await fetch(`${url}/api/capabilities`);
    expect(response.status).toBe(200);
    const descriptor = (await response.json()) as CapabilityDescriptor;
    expect(descriptor).toMatchObject({
      edition: "community",
      contract_version: CONTRACT_VERSION,
      mcp_revisions: ["2025-11-25", "2026-07-28"],
      features: { vector: false, brief: true, closing_note: true },
      model_runners: [],
      tools: TOOLS.map((tool) => tool.name),
      prompts: ["activate", "setup"],
      degraded: ["no_model"],
    });
  });

  test("the first result of a session carries a brief and the second does not", async () => {
    const client = await connect("brief-check");
    const first = await client.callTool("publish_fact", {
      project: PROJECT,
      claim: CLAIM,
      citations: [CITATION],
    });
    expect(first.isError, first.text).toBe(false);
    const brief = briefOf(first.structuredContent);
    expect(brief).toMatchObject({ held: [], tasks: [], lapsed: [], fact_count: 1 });
    expect(brief?.facts).toEqual([
      { id: first.structuredContent?.id, claim: CLAIM, trust: "unreviewed" },
    ]);
    expect(first.text).toContain(`Session brief for ${PROJECT}`);
    expect(first.text).toContain("Facts (1 of 1 shown; search_facts finds the rest):");

    const second = await client.callTool("search_facts", { project: PROJECT, query: "webhooks" });
    expect(second.isError).toBe(false);
    expect(second.structuredContent).toMatchObject({ session: first.structuredContent?.session });
    expect(briefOf(second.structuredContent)).toBeUndefined();
    expect(second.text).not.toContain("Session brief");
  });

  test("after the idle gap a new session opens, and its brief says how the last one ended", async () => {
    const client = await connect("gap-check");
    const before = await client.callTool("search_facts", { project: PROJECT, query: "webhooks" });
    clock().advance(SESSION_IDLE_MS + 60_000);
    const unclosed = await client.callTool("search_facts", { project: PROJECT, query: "retry" });
    expect(unclosed.structuredContent?.session).not.toBe(before.structuredContent?.session);
    expect(briefOf(unclosed.structuredContent)?.last_session).toMatchObject({
      session: before.structuredContent?.session,
      client: "gap-check",
      closed: false,
      calls: 1,
    });
    expect(unclosed.text).toContain("never closed: 1 call, the last at 2026-11-13T09:0");
  });

  test("a client that starts anew gets its brief on its first call, seconds after the one before it stopped", async () => {
    const project = "github.com/acme/ferry-times";
    const search = { project, query: "which port does the server listen on" };
    // Neither sends a conversation id: each is known by the connection it opens, as Claude Code
    // is, and like Claude Code each asks for the server's lists as soon as it has connected.
    const started = async () => {
      const client = await connect("restarting-harness");
      await client.listPrompts();
      await client.listTools();
      return client;
    };
    const first = await started();
    const opened = await first.callTool("search_facts", search);
    const session = opened.structuredContent?.session;
    expect(briefOf(opened.structuredContent)).toBeDefined();
    expect((await first.callTool("search_facts", search)).structuredContent).not.toHaveProperty(
      "brief",
    );
    await first.close();

    clock().advance(3000);
    const second = await started();
    const again = await second.callTool("search_facts", search);
    expect(again.structuredContent?.session).not.toBe(session);
    // The session before it may still be running for all the server knows, and the brief says so.
    expect(briefOf(again.structuredContent)?.last_session).toMatchObject({ session, open: true });
    const next = await second.callTool("search_facts", search);
    expect(next.structuredContent).toMatchObject({ session: again.structuredContent?.session });
    expect(next.structuredContent).not.toHaveProperty("brief");

    // A request the server cannot place on a connection, as after its own restart, opens nothing:
    // it goes on in the client's open session and is handed no second brief.
    const response = await api("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "user-agent": "restarting-harness/1.0.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 57,
        method: "tools/call",
        params: { name: "search_facts", arguments: search },
      }),
    });
    const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
    const unplaced = (JSON.parse((data ?? "").slice(6)) as { result: McpCallResult }).result;
    expect(unplaced.structuredContent).toMatchObject({ session: again.structuredContent?.session });
    expect(unplaced.structuredContent).not.toHaveProperty("brief");
  });

  test("a client's conversation id separates its sessions; its name and version come from the request", async () => {
    const call = async (conversation: string) => {
      const response = await api("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "user-agent": "antigravity/1.5.8 (linux)",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "search_facts",
            arguments: { project: "github.com/acme/console", query: "themes" },
            _meta: { "antigravity.google/conversation_id": conversation },
          },
        }),
      });
      const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
      const message = JSON.parse((data ?? "").slice(6)) as {
        result: { structuredContent: { session: string } };
      };
      return message.result.structuredContent.session;
    };
    const first = await call("conversation-1");
    expect(await call("conversation-2")).not.toBe(first);
    expect(await call("conversation-1")).toBe(first);
    const activity = (await (await api("/api/activity")).json()) as ActivityReport;
    expect(activity.clients).toContainEqual(
      expect.objectContaining({ client: "antigravity", version: "1.5.8", sessions: 2 }),
    );
  });

  test("a field a route does not take is refused by name", async () => {
    const unknown = await api("/api/facts?limit=5&offset=10");
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toMatchObject({
      error: { code: "invalid_input", what: expect.stringContaining("offset") as string },
    });
  });

  test("a refused call teaches the project and lists the person's named projects", async () => {
    const client = await connect("refusal-check");
    const bare = await client.callTool("search_facts", { query: "webhooks" });
    expect(bare.text).toBe(PROJECT_REFUSAL);

    // Only a person makes a project: a harness's token is refused, the signed-in browser is not.
    expect((await post("/api/projects", { slug: "q4-expenses" })).status).toBe(403);
    const person = await server.browser();
    const created = await person.post("/api/projects", {
      slug: "q4-expenses",
      name: "Q4 expenses",
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ key: "me/q4-expenses", kind: "named" });
    expect((await person.post("/api/projects", { slug: "q4-expenses" })).status).toBe(409);
    expect((await person.post("/api/projects", { slug: "Not A Slug" })).status).toBe(422);

    for (const args of [{ query: "webhooks" }, { project: "me/unknown", query: "webhooks" }]) {
      const refused = await client.callTool("search_facts", args);
      expect(refused.isError).toBe(true);
      expect(refused.text).toBe(
        `${PROJECT_REFUSAL}\nYour named projects: me/q4-expenses (Q4 expenses)`,
      );
      expect(refused.structuredContent).toMatchObject({
        error: { code: "project_required", details: { named_projects: ["me/q4-expenses"] } },
      });
    }
    const named = await client.callTool("search_facts", {
      project: "me/q4-expenses",
      query: "travel",
    });
    expect(named.structuredContent).toMatchObject({ project: "me/q4-expenses", matched: 0 });

    const activity = (await (await api("/api/activity")).json()) as ActivityReport;
    expect(activity.clients.find((row) => row.client === "refusal-check")).toEqual({
      client: "refusal-check",
      version: "1.0.0",
      sessions: 2,
      searched: 1,
      published: 0,
      refused: 1,
    });
    expect(activity.recent[0]).toMatchObject({
      client: "refusal-check",
      project: "me/q4-expenses",
    });
  });
});
