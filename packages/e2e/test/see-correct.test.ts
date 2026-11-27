/**
 * A person reads, corrects and removes what is stored, end to end: an agent publishes a fact and a
 * task and leaves a note over `/mcp` and the harness's hooks; the person, signed in to the
 * dashboard, corrects the fact, closes the task, removes the note and deletes the project; and
 * each time the next brief and the next search show what agents are then given. On the embedded
 * engine and on PostgreSQL.
 */
import type {
  ActivityReport,
  ClaudeCodeHookOutput,
  FactDetail,
  FactPage,
  ProjectContents,
  ProjectDeleted,
  ProjectJoined,
  ProjectList,
  SearchFactsResult,
  SearchTasksResult,
} from "@uketsugi/contracts";
import { connectMcp, type McpTestClient } from "@uketsugi/testkit";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeOnEachEngine, signInOnHost, type Host } from "./local-hosts.ts";

const TOKEN = "ukt_test_token_of_whoever_runs_the_server";
const PROJECT = "github.com/acme/ledger";
const CLAIM = "Never rename the ledger table; billing reads it by name";
const CORRECTED = "Never rename the ledger table; billing and reporting read it by name";
const TASK = "Backfill the ledger audit column";
const NOTE = "Stopped half way through the audit column backfill";

describeOnEachEngine("a person's own corrections", (open) => {
  let host: Host;
  let url = "";
  let agent: McpTestClient;
  let calls = 0;
  const closing: McpTestClient[] = [];
  const person = () => signInOnHost(url);

  /** One hook of a Claude Code conversation in this project, as the plugin's script sends it. */
  async function hook(conversation: string, event: string, more: object = {}) {
    const response = await fetch(`${url}/api/hooks/claude-code`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "x-uketsugi-origin": `https://${PROJECT}.git`,
      },
      body: JSON.stringify({ hook_event_name: event, session_id: conversation, ...more }),
    });
    expect(response.status, event).toBe(200);
    return (await response.json()) as ClaudeCodeHookOutput;
  }

  /** A tool call of a conversation, tied to it by the hook before it. */
  async function call(conversation: string, tool: string, args: Record<string, unknown>) {
    const use = `toolu_${conversation}_${(calls += 1)}`;
    await hook(conversation, "PreToolUse", {
      tool_name: `mcp__plugin_uketsugi_uketsugi__${tool}`,
      tool_use_id: use,
    });
    const result = await agent.callTool(
      tool,
      { project: PROJECT, ...args },
      { "claudecode/toolUseId": use },
    );
    expect(result.isError, result.text).toBe(false);
    return result;
  }

  /** What a new session of the project is handed as it starts. */
  async function brief(conversation: string): Promise<string> {
    return (
      (await hook(conversation, "SessionStart", { source: "startup" })).hookSpecificOutput
        ?.additionalContext ?? ""
    );
  }

  const read = async <T>(path: string): Promise<T> => {
    const browser = await person();
    return (await browser.get(path)).json() as Promise<T>;
  };

  beforeAll(async () => {
    host = await open(TOKEN);
    url = host.server.url;
    agent = await connectMcp({
      url: `${url}/mcp`,
      token: TOKEN,
      client: { name: "claude-code", version: "1.0.0" },
    });
    closing.push(agent);
  });

  afterAll(async () => {
    await Promise.all(closing.map((client) => client.close()));
    await host.close();
  });

  test("the person corrects a fact, closes a task and removes a note, and the next session is given none of what they took out", async () => {
    const told = { kind: "person", who: "ann", quote: "never rename the ledger table" };
    const fact = await call("c-one", "publish_fact", { claim: CLAIM, citations: [told] });
    const factId = String(fact.structuredContent?.id);
    const task = await call("c-one", "publish_task", { title: TASK });
    const taskId = String((task.structuredContent?.task as { id: string }).id);
    await hook("c-one", "Stop", { last_assistant_message: NOTE });
    const before = await brief("c-two");
    expect(before).toContain(CLAIM);
    expect(before).toContain(TASK);

    // The note is on Activity, where the person reads it.
    const noted = (await read<ActivityReport>("/api/activity")).recent.find((s) => s.note !== null);
    expect(noted?.note).toMatchObject({ text: NOTE, final: false });

    const browser = await person();
    // Only a signed-in person does these: the agent's token is refused.
    for (const [path, body] of [
      [`/api/facts/${factId}/correct`, { claim: CORRECTED }],
      [`/api/facts/${factId}/confirm`, {}],
      [`/api/tasks/${taskId}/close`, {}],
    ] as const) {
      const refused = await fetch(`${url}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(refused.status, path).toBe(403);
    }

    const corrected = await browser.post(`/api/facts/${factId}/correct`, { claim: CORRECTED });
    expect(await corrected.json()).toEqual({ id: factId, changed: true });
    const closed = await browser.post(`/api/tasks/${taskId}/close`);
    expect(await closed.json()).toEqual({ id: taskId, changed: true });
    const removed = await browser.del(`/api/sessions/${noted?.session}/note`);
    expect(await removed.json()).toEqual({ session: noted?.session });

    // Agents are given the corrected fact and neither the task nor the note.
    const search = await agent.callTool("search_facts", {
      project: PROJECT,
      query: "ledger table",
    });
    const found = (search.structuredContent as unknown as SearchFactsResult).facts;
    expect(found.map((entry) => entry.claim)).toEqual([CORRECTED]);
    const tasks = await agent.callTool("search_tasks", { project: PROJECT });
    expect((tasks.structuredContent as unknown as SearchTasksResult).tasks).toEqual([]);
    const after = await brief("c-three");
    expect(after).toContain(CORRECTED);
    expect(after).not.toContain(CLAIM);
    expect(after).not.toContain(TASK);
    expect(after).not.toContain(NOTE);
    // The correction is in the fact's history as the person's, and the note is gone from Activity.
    const detail = await read<FactDetail>(`/api/facts/${factId}`);
    expect(detail.history[0]).toMatchObject({ kind: "FactRewritten", actor: "you" });
    const activity = await read<ActivityReport>("/api/activity");
    expect(activity.recent.every((session) => session.note === null)).toBe(true);
  });

  test("the person is shown what deleting a project takes, then deletes it, and nothing of it is left", async () => {
    const browser = await person();
    const named = new URLSearchParams({ project: PROJECT }).toString();
    const shown = (await (
      await browser.get(`/api/projects/contents?${named}`)
    ).json()) as ProjectContents;
    expect(shown).toMatchObject({ project: PROJECT, facts: 1, tasks: 1, others_facts: 0 });
    expect(shown.sessions).toBeGreaterThan(0);

    const gone = await browser.del("/api/projects", { project: PROJECT });
    expect(gone.status).toBe(200);
    expect((await gone.json()) as ProjectDeleted).toMatchObject({ facts: 1, tasks: 1 });

    expect(((await (await browser.get("/api/facts")).json()) as FactPage).facts).toEqual([]);
    const projects = (await (await browser.get("/api/projects")).json()) as ProjectList;
    expect(projects.projects.map((project) => project.key)).not.toContain(PROJECT);
    const search = await agent.callTool("search_facts", { project: PROJECT, query: "ledger" });
    expect((search.structuredContent as unknown as SearchFactsResult).facts).toEqual([]);
    // The agent's own search opened a session there again; the project holds nothing else.
    const left = await browser.get(`/api/projects/contents?${named}`);
    expect(await left.json()).toMatchObject({ facts: 0, tasks: 0, others_facts: 0 });
  });

  test("the person joins a renamed repository's old project into its new key, and an agent that still names the old one is given the memory", async () => {
    const [old, renamed] = ["github.com/acme/ledger-old", "github.com/acme/ledger-renamed"];
    const told = { kind: "person", who: "ann", quote: "the ledger audit runs nightly" };
    const claim = "The ledger audit runs nightly at two";
    const published = await agent.callTool("publish_fact", {
      project: old,
      claim,
      citations: [told],
    });
    expect(published.isError, published.text).toBe(false);
    const ask = async (project: string) =>
      (
        (await agent.callTool("search_facts", { project, query: "ledger audit nightly" }))
          .structuredContent as unknown as SearchFactsResult
      ).facts.map((entry) => entry.claim);
    expect(await ask(renamed)).toEqual([]);

    // Only a signed-in person joins: the agent's token is refused, and a bad body is named.
    const refused = await fetch(`${url}/api/projects/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ from: old, into: renamed }),
    });
    expect(refused.status).toBe(403);
    const browser = await person();
    expect((await browser.post("/api/projects/join", { from: old })).status).toBe(422);
    expect((await browser.post("/api/projects/join", { from: old, into: old })).status).toBe(422);
    expect(await ask(old)).toEqual([claim]);

    const joined = await browser.post("/api/projects/join", { from: old, into: renamed });
    expect(joined.status).toBe(200);
    expect((await joined.json()) as ProjectJoined).toEqual({
      from: old,
      into: renamed,
      facts: 1,
      tasks: 0,
      sessions: 1,
    });
    expect(await ask(renamed)).toEqual([claim]);
    expect(await ask(old)).toEqual([claim]);
    const projects = (await (await browser.get("/api/projects")).json()) as ProjectList;
    expect(projects.projects.find((project) => project.key === renamed)).toMatchObject({
      names: [old],
      facts: 1,
    });
    expect(projects.projects.map((project) => project.key)).not.toContain(old);
  });
});
