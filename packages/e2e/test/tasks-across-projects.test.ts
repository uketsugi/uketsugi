/**
 * A task as the message from one project to another, and the dashboard's Tasks page behind it, end
 * to end over `/mcp` and `/api`: an agent working in one project publishes a task into another; a
 * later session there finds it in its brief and takes it; and each person's dashboard lists
 * exactly the tasks the sharing rules let them see, each with its notes and its history. First on
 * a server with one person, then with a second. On the embedded engine and on PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import type {
  ClaimTaskResult,
  Invitation,
  PublishTaskResult,
  SearchFactsResult,
  SearchTasksResult,
  TaskDetail,
  TaskPage,
} from "@uketsugi/contracts";
import { connectMcp, type McpTestClient } from "@uketsugi/testkit";
import { afterAll, beforeAll, expect, test } from "vitest";
import { asHost, describeOnEachEngine, signIn, signInOnHost, type Host } from "./local-hosts.ts";

const ANN = "ukt_test_token_of_whoever_runs_the_server";
/** The project Ann's agent works in, and the one the work it comes across belongs to. */
const GATEWAY = "github.com/acme/api-gateway";
const BILLING = "github.com/acme/billing-service";

const ASKED = "Return retry_count from GET /invoices/:id";
const WHY = "The gateway's invoice page shows retries and reads them here. Asked from api-gateway.";
const DOCUMENT = "Document retry_count in the invoices reference";
const STEP = "Step 2: check the gateway's cache key";
const LOCAL = "Bump the billing client in the gateway";

type Browser = Awaited<ReturnType<typeof signIn>>;

describeOnEachEngine("a task published into another project", (open) => {
  let host: Host;
  let url = "";
  let bob = "";
  let bobsKey = "";
  /** Ann's agent, at work in the gateway's repository. */
  let working: McpTestClient;
  const clients: McpTestClient[] = [];
  const ids = { asked: "", document: "", step: "", local: "" };

  async function connect(token: string, name: string): Promise<McpTestClient> {
    const client = await connectMcp({ url: `${url}/mcp`, token, client: { name, version: "1" } });
    clients.push(client);
    return client;
  }

  /** A call that must succeed: its text, and its result as the contract types it. */
  async function call<T>(by: McpTestClient, tool: string, args: Record<string, unknown>) {
    const result = await by.callTool(tool, args);
    expect(result.isError, result.text).toBe(false);
    return { text: result.text, content: result.structuredContent as T };
  }

  const read = async <T>(by: Browser, path: string) => (await (await by.get(path)).json()) as T;
  const inProject = (project: string) => `project=${encodeURIComponent(project)}`;
  /** Every task a person's dashboard lists, whatever its state, by id. */
  async function listed(by: Browser): Promise<string[]> {
    const pages = await Promise.all(
      ["/api/tasks?limit=500", "/api/tasks?status=done"].map((path) => read<TaskPage>(by, path)),
    );
    return pages.flatMap((page) => page.tasks.map((task) => task.id)).sort();
  }

  beforeAll(async () => {
    host = await open(ANN);
    url = host.server.url;
    working = await connect(ANN, "claude-code");
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await host.close();
  });

  test("an agent working in one project publishes a task into another, and a later session there finds it in its brief and takes it", async () => {
    const here = await call<SearchFactsResult>(working, "search_facts", {
      project: GATEWAY,
      query: "where do invoice retries come from",
    });
    const published = await call<PublishTaskResult>(working, "publish_task", {
      project: BILLING,
      title: ASKED,
      description: WHY,
    });
    expect(published.content).toMatchObject({
      created: true,
      project: BILLING,
      task: { title: ASKED, state: "open", publisher: "you" },
    });
    expect(published.content.session).not.toBe(here.content.session);
    ids.asked = published.content.task.id;
    // The task belongs to the project it was published into, not to the one its publisher works in.
    const own = await call<SearchTasksResult>(working, "search_tasks", { project: GATEWAY });
    expect(own.content.matched).toBe(0);

    const later = await connect(ANN, "antigravity");
    const first = await call<SearchFactsResult>(later, "search_facts", {
      project: BILLING,
      query: "retry count",
    });
    expect(first.content.brief?.tasks).toMatchObject([
      { id: ids.asked, title: ASKED, state: "open", publisher: "you" },
    ]);
    expect(first.text).toContain("Open tasks (1):");
    expect(first.text).toContain(`- ${ids.asked} · ${ASKED} · open · v1`);

    const claimed = await call<ClaimTaskResult>(later, "claim_task", {
      project: BILLING,
      id: ids.asked,
    });
    expect(claimed.content).toMatchObject({
      renewed: false,
      task: { state: "claimed", holder: "you", holder_client: "antigravity", description: WHY },
    });
    await call(later, "update_task", {
      project: BILLING,
      id: ids.asked,
      lease: claimed.content.lease,
      note: "retry_count is on the serializer; the route test is next.",
    });
  });

  test("the dashboard lists the task in the project it belongs to, with who holds it, its notes and its history", async () => {
    const hers = await signInOnHost(url);
    const page = await read<TaskPage>(hers, "/api/tasks");
    expect(page).toMatchObject({
      matched: 1,
      tasks: [
        {
          id: ids.asked,
          project: BILLING,
          title: ASKED,
          state: "claimed",
          publisher: "you",
          holder: "you",
          holder_client: "antigravity",
          audience: "private",
          note: "retry_count is on the serializer; the route test is next.",
          note_by: "you",
        },
      ],
    });
    expect(page.tasks[0]?.description).toBeUndefined();
    expect(Date.parse(page.tasks[0]?.lease_expires_at ?? "")).toBeGreaterThan(Date.now());
    const found = async (query: string) =>
      (await read<TaskPage>(hers, `/api/tasks?${query}`)).tasks.map((task) => task.id);
    expect(await found(`${inProject(BILLING)}&status=claimed`)).toEqual([ids.asked]);
    expect(await found(inProject(GATEWAY))).toEqual([]);
    expect(await found("status=open")).toEqual([]);
    expect(await found("status=done")).toEqual([]);
    for (const refused of ["project=nowhere", "status=finished", "limit=0", "mine=true"]) {
      expect((await hers.get(`/api/tasks?${refused}`)).status, refused).toBe(422);
    }

    const detail = await read<TaskDetail>(hers, `/api/tasks/${ids.asked}`);
    expect(detail.task).toMatchObject({ id: ids.asked, project: BILLING, description: WHY });
    expect(detail.notes).toMatchObject([{ kind: "note", author: "you", client: "antigravity" }]);
    expect(detail.history).toMatchObject([
      { event: "published", by: "you", client: "claude-code" },
      { event: "claimed", by: "you", client: "antigravity" },
    ]);
    expect((await hers.get(`/api/tasks/${randomUUID()}`)).status).toBe(404);
    expect((await fetch(`${url}/api/tasks`)).status).toBe(401);
  });

  test("a person added to the server sees none of it until its publisher shares the project", async () => {
    const invited = await asHost(url)("/api/people", {
      method: "POST",
      body: JSON.stringify({ name: "bob", operator_name: "ann" }),
    });
    const [token, key] = ((await invited.json()) as Invitation).issued;
    [bob, bobsKey] = [token?.secret ?? "", key?.secret ?? ""];
    const his = await signIn(url, bobsKey);
    expect(await read<TaskPage>(his, "/api/tasks")).toEqual({ tasks: [], matched: 0 });
    expect((await his.get(`/api/tasks/${ids.asked}`)).status).toBe(404);
    const agent = await connect(bob, "bob-claude");
    const looked = await call<SearchTasksResult>(agent, "search_tasks", { project: BILLING });
    expect(looked.content).toMatchObject({
      matched: 0,
      brief: { tasks: [], held: [], lapsed: [] },
    });

    const hers = await signInOnHost(url);
    const shared = await hers.choose(BILLING, "shared");
    expect(await shared.json()).toMatchObject({ treatment: "shared", moved: { tasks: 1 } });
    expect((await read<TaskPage>(his, "/api/tasks")).tasks).toMatchObject([
      {
        id: ids.asked,
        state: "claimed",
        publisher: "ann",
        holder: "ann",
        holder_client: "antigravity",
        audience: "shared",
      },
    ]);
  });

  test("what the agent leaves in the shared project reaches another person's later session, which takes and finishes it", async () => {
    const left = await call<PublishTaskResult>(working, "publish_task", {
      project: BILLING,
      title: DOCUMENT,
    });
    expect(left.text).toContain(`project: ${BILLING} · used here, shared`);
    const step = await call<PublishTaskResult>(working, "publish_task", {
      project: BILLING,
      title: STEP,
      tracked: true,
    });
    const local = await call<PublishTaskResult>(working, "publish_task", {
      project: GATEWAY,
      title: LOCAL,
    });
    Object.assign(ids, {
      document: left.content.task.id,
      step: step.content.task.id,
      local: local.content.task.id,
    });

    const his = await signIn(url, bobsKey);
    expect((await his.choose(BILLING, "shared")).status).toBe(200);
    const later = await connect(bob, "bob-codex");
    const first = await call<SearchFactsResult>(later, "search_facts", {
      project: BILLING,
      query: "retry count",
    });
    // Ann's agent holds the first task, and her agent's own step is hers alone: one task is open to him.
    expect(first.content.brief?.tasks).toMatchObject([
      { id: ids.document, title: DOCUMENT, state: "open", publisher: "ann" },
    ]);
    expect(first.content.brief?.tasks).toHaveLength(1);
    expect(first.text).not.toContain(STEP);

    const claimed = await call<ClaimTaskResult>(later, "claim_task", {
      project: BILLING,
      id: ids.document,
    });
    const done = await call<{ task: { state: string } }>(later, "update_task", {
      project: BILLING,
      id: ids.document,
      lease: claimed.content.lease,
      state: "done",
      note: "Documented in docs/invoices.md.",
    });
    expect(done.content.task.state).toBe("done");
  });

  test("each person's dashboard shows exactly the tasks the sharing rules let them see, and each task's history as far as they may read it", async () => {
    const [hers, his] = [await signInOnHost(url), await signIn(url, bobsKey)];
    expect(await listed(his)).toEqual([ids.asked, ids.document].sort());
    expect(await listed(hers)).toEqual(Object.values(ids).sort());
    for (const id of [ids.step, ids.local]) {
      expect((await his.get(`/api/tasks/${id}`)).status).toBe(404);
    }
    const paths = [
      "/api/tasks?limit=500",
      "/api/tasks?status=done",
      `/api/tasks?${inProject(GATEWAY)}`,
    ];
    const everything = (
      await Promise.all(paths.map(async (path) => (await his.get(path)).text()))
    ).join("\n");
    expect(everything).toContain(ASKED);
    expect(everything).not.toContain(STEP);
    expect(everything).not.toContain(LOCAL);

    // The finished task reads the same to both, each as themselves.
    const finished = (await read<TaskPage>(his, "/api/tasks?status=done")).tasks[0];
    expect(finished).toMatchObject({
      id: ids.document,
      project: BILLING,
      state: "done",
      publisher: "ann",
      audience: "shared",
      note: "Documented in docs/invoices.md.",
      note_by: "you",
    });
    expect(finished?.holder).toBeUndefined();
    const steps = async (by: Browser, id: string) => {
      const { history } = await read<TaskDetail>(by, `/api/tasks/${id}`);
      return history.map((step) => [step.event, step.by, step.client]);
    };
    expect(await steps(his, ids.document)).toEqual([
      ["published", "ann", "claude-code"],
      ["claimed", "you", "bob-codex"],
      ["done", "you", "bob-codex"],
    ]);
    expect(await steps(hers, ids.document)).toEqual([
      ["published", "you", "claude-code"],
      ["claimed", "bob", "bob-codex"],
      ["done", "bob", "bob-codex"],
    ]);
    // What happened to the first task before it was shared is its publisher's to read; its note moved with it.
    expect(await steps(his, ids.asked)).toEqual([]);
    expect(await steps(hers, ids.asked)).toHaveLength(2);
    const { notes } = await read<TaskDetail>(his, `/api/tasks/${ids.asked}`);
    expect(notes).toMatchObject([{ author: "ann", client: "antigravity" }]);

    const mine = (await read<TaskPage>(hers, "/api/tasks")).tasks;
    expect(mine.find((task) => task.id === ids.step)).toMatchObject({
      project: BILLING,
      tracked: true,
      audience: "private",
    });
    expect(mine.find((task) => task.id === ids.local)).toMatchObject({
      project: GATEWAY,
      audience: "private",
    });
  });

  test("when the publisher keeps the project private again, her tasks leave the other person's dashboard", async () => {
    const [hers, his] = [await signInOnHost(url), await signIn(url, bobsKey)];
    const back = await hers.choose(BILLING, "private");
    expect(await back.json()).toMatchObject({ treatment: "private", moved: { tasks: 2 } });
    expect(await listed(his)).toEqual([]);
    expect((await his.get(`/api/tasks/${ids.document}`)).status).toBe(404);
    expect(await listed(hers)).toEqual(Object.values(ids).sort());
    const { tasks } = await read<TaskPage>(hers, "/api/tasks?status=done");
    expect(tasks).toMatchObject([{ id: ids.document, audience: "private" }]);
  });
});
