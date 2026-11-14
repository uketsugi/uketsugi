/**
 * Claude Code with the plugin, as the server sees it: a conversation whose hooks say when it
 * starts, which conversation each call belongs to, where each turn ended and when it is over.
 */
import {
  BLOCK_TEXT,
  type ActivityReport,
  type Brief,
  type ClaudeCodeHookOutput,
  type Invitation,
} from "@uketsugi/contracts";
import { SESSION_IDLE_MS } from "@uketsugi/core";
import type { McpCallResult, McpTestClient } from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CITATION, CLAIM, PROJECT, startServer, type RunningServer } from "./running-server.ts";

const HOOKS = "/api/hooks/claude-code";

describe("a harness whose hooks speak for its sessions", () => {
  let server: RunningServer;
  let claude: McpTestClient;
  const briefOf = (result: McpCallResult) => result.structuredContent?.brief as Brief | undefined;
  const sessionOf = (result: McpCallResult) => String(result.structuredContent?.session);

  /** One hook of a conversation's, sent as the plugin's script sends it. */
  function send(
    conversation: string,
    origin: string | null,
    event: string,
    more: object,
    authorization = server.bearer.authorization,
  ): Promise<Response> {
    const named = origin === null ? {} : { "x-uketsugi-origin": origin };
    const body = { hook_event_name: event, session_id: conversation, cwd: "/home/ann/work" };
    return fetch(`${server.url}${HOOKS}`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json", ...named },
      body: JSON.stringify({ ...body, ...more }),
    });
  }

  /** A conversation of Claude Code's, in a directory whose origin remote is `origin`. */
  function conversation(id: string, origin: string | null) {
    let calls = 0;
    const hook = async (event: string, more: object = {}): Promise<ClaudeCodeHookOutput> => {
      const response = await send(id, origin, event, more);
      expect(response.status, event).toBe(200);
      return (await response.json()) as ClaudeCodeHookOutput;
    };
    return {
      /** What the session starts from: the context its start hook is answered with. */
      async start(source = "startup"): Promise<string> {
        const { hookSpecificOutput } = await hook("SessionStart", { source });
        return hookSpecificOutput?.additionalContext ?? "";
      },
      /** A call of one of the server's tools: the hook before it, then the call under the same id. */
      async call(tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
        const use = `toolu_${id}_${(calls += 1)}`;
        await hook("PreToolUse", {
          tool_name: `mcp__plugin_uketsugi_uketsugi__${tool}`,
          tool_use_id: use,
        });
        return claude.callTool(tool, args, { "claudecode/toolUseId": use });
      },
      stop: (message: string) => hook("Stop", { last_assistant_message: message }),
      end: () => hook("SessionEnd", { reason: "prompt_input_exit" }),
    };
  }

  beforeAll(async () => {
    server = await startServer();
    claude = await server.connect("claude-code");
  });

  afterAll(() => server.close());

  test("a session that starts is handed the block and its brief before it calls anything, and its first call carries no second brief", async () => {
    const writer = await server.connect("another-harness");
    await writer.callTool("publish_fact", {
      project: PROJECT,
      claim: CLAIM,
      citations: [CITATION],
    });
    const session = conversation("c-start", "git@github.com:acme/billing-service.git");
    const context = await session.start();
    expect(context.startsWith(`${BLOCK_TEXT}\nSession brief for ${PROJECT}, from memory.`)).toBe(
      true,
    );
    expect(context).toContain(CLAIM);

    const search = { project: PROJECT, query: "webhooks" };
    const first = await session.call("search_facts", search);
    expect(first.isError, first.text).toBe(false);
    expect(briefOf(first)).toBeUndefined();
    expect(first.text).not.toContain("Session brief");
    // After a compaction the harness starts the session again: the same session, a fresh brief.
    expect(await session.start("compact")).toContain(`Session brief for ${PROJECT}`);
    expect(sessionOf(await session.call("search_facts", search))).toBe(sessionOf(first));

    // The session began before its client had said its version: its first call tells it.
    const activity = (await (await server.api("/api/activity")).json()) as ActivityReport;
    expect(activity.recent).toContainEqual(
      expect.objectContaining({
        session: sessionOf(first),
        client: "claude-code",
        version: "1.0.0",
      }),
    );
  });

  test("each call goes on the session of the conversation its hook named, though two conversations call on one connection", async () => {
    const project = "github.com/acme/twins";
    const [one, two] = ["c-one", "c-two"].map((id) => conversation(id, `https://${project}.git`));
    await one?.start();
    await two?.start();
    const search = { project, query: "pairing" };
    const mine = await one?.call("search_facts", search);
    const theirs = await two?.call("search_facts", search);
    const again = await one?.call("publish_fact", { project, claim: CLAIM, citations: [CITATION] });
    expect(sessionOf(mine!)).not.toBe(sessionOf(theirs!));
    expect(sessionOf(again!)).toBe(sessionOf(mine!));
    expect([mine, theirs, again].map((result) => briefOf(result!))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);

    // A call into another project has a session there, with that project's brief, and the
    // conversation's session here goes on.
    const elsewhere = await one?.call("search_facts", {
      project: "github.com/acme/elsewhere",
      query: "x",
    });
    expect(briefOf(elsewhere!)).toBeDefined();
    expect(sessionOf((await one?.call("search_facts", search))!)).toBe(sessionOf(mine!));
  });

  test("a turn's last message is its session's note, the end makes it the last word, and the next session's brief shows it", async () => {
    const project = "github.com/acme/search";
    const first = conversation("c-notes", `https://${project}`);
    await first.start();
    const opened = await first.call("search_facts", { project, query: "ranking" });
    await first.stop("Ranking is half tuned.");
    server.clock.advance(60_000);
    const same = await first.call("search_facts", { project, query: "ranking weights" });
    expect(sessionOf(same)).toBe(sessionOf(opened));
    const secret = `ghp_${"16C7e42F292c6912E7710c838347Ae178B4a"}`;
    await first.stop(
      `Ranking is tuned; the synonyms file is next. I read the issue with ${secret}.`,
    );
    await first.end();

    server.clock.advance(2 * 60_000);
    const context = await conversation("c-notes-next", `https://${project}`).start();
    expect(context).toContain(
      `Your previous session here (${sessionOf(opened)}, claude-code) closed at`,
    );
    expect(context).toContain(
      "Ranking is tuned; the synonyms file is next. I read the issue with [redacted:github-token].",
    );
    expect(context).not.toContain(secret);
    expect(context).not.toContain("half tuned");

    // The session has had its last word: a conversation that goes on has a new one.
    const resumed = await first.call("search_facts", { project, query: "synonyms" });
    expect(sessionOf(resumed)).not.toBe(sessionOf(opened));
  });

  test("a session that is killed never says it ended, and the next brief has its latest note", async () => {
    const project = "github.com/acme/migration";
    const killed = conversation("c-killed", `https://${project}`);
    await killed.start();
    const worked = await killed.call("search_facts", { project, query: "users table" });
    await killed.stop("Half-way through the migration: the users table is done, orders is next.");

    server.clock.advance(SESSION_IDLE_MS + 60_000);
    const context = await conversation("c-after-kill", `https://${project}`).start();
    expect(context).toContain(
      `Your previous session here (${sessionOf(worked)}, claude-code) never closed: 1 call`,
    );
    expect(context).toContain("Its latest note, from");
    expect(context).toContain("the users table is done, orders is next.");
  });

  test("a note goes on its own conversation's session, never on another harness's in the same project", async () => {
    const project = "github.com/acme/ledger";
    const other = await server.connect("another-harness");
    const theirs = await other.callTool("search_facts", { project, query: "rounding" });
    const mine = conversation("c-mine", `https://${project}`);
    await mine.start();
    await mine.stop("Rounding is settled in ledger/round.ts.");
    await mine.end();

    // The other harness's session is neither closed nor given the note.
    server.clock.advance(60_000);
    const still = await other.callTool("search_facts", { project, query: "rounding mode" });
    expect(sessionOf(still)).toBe(sessionOf(theirs));
    expect(briefOf(still)).toBeUndefined();
    const context = await conversation("c-third", `https://${project}`).start();
    expect(context).toContain(`(${sessionOf(theirs)}, another-harness) is still open: 2 calls`);
    expect(context).not.toContain("Rounding is settled");
  });

  test("a session that only began says nothing of how work stands, and the next brief passes over it", async () => {
    const project = "github.com/acme/quiet";
    const worked = conversation("c-worked", `https://${project}`);
    await worked.start();
    await worked.stop("The quiet hours are read from config/hours.toml.");
    await worked.end();
    server.clock.advance(60_000);
    const looked = conversation("c-looked", `https://${project}`);
    await looked.start();
    await looked.end();

    server.clock.advance(60_000);
    const context = await conversation("c-later", `https://${project}`).start();
    expect(context).toContain("closed at");
    expect(context).toContain("The quiet hours are read from config/hours.toml.");
  });

  test("a hook that cannot name the project is answered with the block alone, and its note goes on the session its agent's call opened", async () => {
    const person = await server.browser();
    expect((await person.post("/api/projects", { slug: "harbour-notes" })).status).toBe(201);
    const project = "me/harbour-notes";
    const session = conversation("c-named", null);
    expect(await session.start()).toBe(BLOCK_TEXT);
    // A turn that ends before any call has nowhere to leave its word, and says so to nobody.
    await session.stop("Nothing looked up yet.");
    const first = await session.call("search_facts", { project, query: "tides" });
    expect(briefOf(first)).toMatchObject({ fact_count: 0 });
    await session.stop("The tide table is read from tides.csv.");
    await session.end();

    const next = await conversation("c-named-next", null).call("search_facts", {
      project,
      query: "tides",
    });
    expect(briefOf(next)?.last_session).toMatchObject({
      session: sessionOf(first),
      closed: true,
      note: "The tide table is read from tides.csv.",
    });
  });

  test("an event the server does not act on is answered with nothing, and one without its conversation is refused", async () => {
    const quiet = await send("c-quiet", null, "Notification", {
      message: "Claude needs your attention",
    });
    expect(quiet.status).toBe(200);
    expect(await quiet.json()).toEqual({});
    const unnamed = await fetch(`${server.url}${HOOKS}`, {
      method: "POST",
      headers: { ...server.bearer, "content-type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Stop" }),
    });
    expect(unnamed.status).toBe(422);
    const unsigned = await send("c-quiet", null, "SessionStart", {}, "Bearer ukt_not_a_token");
    expect(unsigned.status).toBe(401);
  });

  test("a person who does not run the server is answered the same: the project is their session's own word, and the brief is theirs", async () => {
    const invited = await server.host("/api/people", {
      method: "POST",
      body: JSON.stringify({ name: "bob", operator_name: "ann" }),
    });
    const token = ((await invited.json()) as Invitation).issued[0]?.secret ?? "";
    const started = await send(
      "c-bob",
      `https://${PROJECT}.git`,
      "SessionStart",
      {},
      `Bearer ${token}`,
    );
    const output = (await started.json()) as ClaudeCodeHookOutput;
    const context = output.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain(`Session brief for ${PROJECT}`);
    // What the server's owner published here is theirs alone until they share the project.
    expect(context).toContain("This project holds no facts yet.");
    expect(context).not.toContain(CLAIM);
  });
});
