import { randomUUID } from "node:crypto";
import type { TaskPage } from "@uketsugi/contracts";
import type { FakeClock, McpCallResult, McpTestClient } from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PROJECT, startServer, type RunningServer } from "./running-server.ts";

const LEASE_MS = 15 * 60_000;
const HANDOFF = "Left: switch the dunning job. Start in jobs/dunning.ts.";

type Fields = Record<string, unknown>;

type TaskResult = Fields & { task: Fields; lease: string; tasks: Fields[] };

/** The task, the lease, the tasks and the rest of a successful task result. */
function ok(result: McpCallResult): TaskResult {
  expect(result.isError, result.text).toBe(false);
  return result.structuredContent as TaskResult;
}

/** The error of a refused call. */
function refused(result: McpCallResult): Fields & { details: { task: Fields } } {
  expect(result.isError, result.text).toBe(true);
  return result.structuredContent?.error as Fields & { details: { task: Fields } };
}

describe("tasks over /mcp on a real server: two clients hand one task over", () => {
  let server: RunningServer;
  let clock: FakeClock;
  let first: McpTestClient;
  let second: McpTestClient;
  let taskId: string;
  let runbookId: string;
  let firstLease: string;
  let secondLease: string;

  const call = (client: McpTestClient, tool: string, args: Fields) =>
    client.callTool(tool, { project: PROJECT, ...args });
  const read = async (id: string) => ok(await call(second, "search_tasks", { id }));

  beforeAll(async () => {
    server = await startServer();
    ({ clock } = server);
    first = await server.connect("claude-code");
    second = await server.connect("antigravity");
  });

  afterAll(() => server.close());

  test("one client publishes and claims a task, notes it and hands it over", async () => {
    const published = ok(
      await call(first, "publish_task", {
        title: "Move webhook retries to the queue",
        description: "Retries run inline today and block the worker.",
        claim: true,
      }),
    );
    expect(published).toMatchObject({
      created: true,
      lease: expect.stringMatching(/^ukl_[0-9a-f]{32}$/) as string,
      task: {
        state: "claimed",
        version: 2,
        publisher: "you",
        holder: "you",
        holder_client: "claude-code",
        held_by_this_session: true,
        lease_expires_at: new Date(clock.now().getTime() + LEASE_MS).toISOString(),
      },
    });
    taskId = String(published.task.id);
    firstLease = published.lease;

    const secret = `ghp_${"R4nd0mT0kenValue1234567890abcdefGHIJ"}`;
    const noted = ok(
      await call(first, "update_task", {
        id: taskId,
        lease: firstLease,
        note: `Retry path moved. The staging token is ${secret}.`,
      }),
    );
    expect(noted).toMatchObject({ changed: true, task: { version: 3, state: "claimed" } });
    expect(noted.task.note).toBe("Retry path moved. The staging token is [redacted:github-token].");

    const released = ok(
      await call(first, "update_task", {
        id: taskId,
        lease: firstLease,
        state: "released",
        note: HANDOFF,
        version: 3,
      }),
    );
    expect(released).toMatchObject({
      changed: true,
      task: { state: "handed_off", version: 4, note: HANDOFF, note_kind: "handoff" },
    });
    expect(released.task.holder).toBeUndefined();
  });

  test("the second client finds it first, however often it looks, and claims it with its notes", async () => {
    runbookId = String(
      ok(await call(first, "publish_task", { title: "Write the runbook" })).task.id,
    );
    const listed = await call(second, "search_tasks", {});
    expect(ok(listed)).toMatchObject({
      matched: 2,
      shown: 2,
      tasks: [
        {
          id: taskId,
          state: "handed_off",
          note: HANDOFF,
          note_by: "you",
          note_client: "claude-code",
        },
        { id: runbookId, state: "open", version: 1 },
      ],
    });
    expect(listed.text).toContain(
      `handoff note (you via claude-code, ${clock.now().toISOString()})`,
    );
    expect(ok(await call(second, "search_tasks", {})).tasks).toEqual(ok(listed).tasks);

    const claimed = ok(await call(second, "claim_task", { id: taskId }));
    expect(claimed).toMatchObject({
      renewed: false,
      task: { state: "claimed", version: 5, holder: "you", holder_client: "antigravity" },
      notes: [
        { kind: "note", author: "you", client: "claude-code" },
        { kind: "handoff", text: HANDOFF, author: "you", client: "claude-code" },
      ],
    });
    secondLease = claimed.lease;
    expect(secondLease).not.toBe(firstLease);
  });

  test("a write with the first client's old lease is refused and names the holder", async () => {
    for (const lease of [firstLease, undefined]) {
      const late = refused(await call(first, "update_task", { id: taskId, lease, note: "Late." }));
      expect(late).toMatchObject({
        code: "lease_held",
        details: { task: { holder: "you", holder_client: "antigravity", version: 5 } },
      });
      expect(late.what).toContain("is claimed by you via antigravity until");
    }
    const claim = refused(await call(first, "claim_task", { id: taskId }));
    expect(claim).toMatchObject({ code: "lease_held", retry: true });
    expect(claim.next).toContain("take_over: true");
    expect(await read(taskId)).toMatchObject({ tasks: [{ version: 5 }], notes: [{}, {}] });
  });

  test("repeated calls change nothing", async () => {
    const note = { id: taskId, lease: secondLease, note: "Dunning job switched.", version: 5 };
    expect(ok(await call(second, "update_task", note))).toMatchObject({
      changed: true,
      task: { version: 6 },
    });
    expect(ok(await call(second, "update_task", note))).toMatchObject({
      changed: false,
      task: { version: 6 },
    });
    const again = ok(await call(second, "claim_task", { id: taskId, lease: secondLease }));
    expect(again).toMatchObject({ renewed: true, lease: secondLease, task: { version: 6 } });
    const republished = ok(
      await call(first, "publish_task", {
        title: " Move webhook  retries to the queue",
        claim: true,
      }),
    );
    expect(republished).toMatchObject({ created: false, task: { id: taskId, version: 6 } });
    expect(republished.lease).toBeUndefined();
    expect((await read(taskId)).notes).toHaveLength(3);
  });

  test("a change against an older version, or with no lease on an open task, is refused", async () => {
    const stale = { id: taskId, lease: secondLease, note: "Based on an old read.", version: 4 };
    expect(refused(await call(second, "update_task", stale))).toMatchObject({
      code: "conflict",
      details: { reason: "stale_version", task: { version: 6 } },
    });
    const unclaimed = await call(second, "update_task", { id: runbookId, note: "Not mine yet." });
    expect(refused(unclaimed)).toMatchObject({ details: { reason: "not_claimed" } });
    expect(refused(await call(second, "claim_task", { id: randomUUID() })).code).toBe("not_found");
    const elsewhere = { project: "github.com/acme/other", id: taskId };
    expect(refused(await second.callTool("claim_task", elsewhere)).code).toBe("not_found");
  });

  test("the second client finishes it, and its life reads back from the log", async () => {
    const done = { id: taskId, lease: secondLease, state: "done", note: "All retries are queued." };
    expect(ok(await call(second, "update_task", done))).toMatchObject({
      changed: true,
      task: { state: "done", version: 7 },
    });
    expect(ok(await call(second, "update_task", done))).toMatchObject({ changed: false });
    const more = await call(second, "update_task", {
      id: taskId,
      lease: secondLease,
      note: "More.",
    });
    expect(refused(more)).toMatchObject({ code: "conflict", details: { reason: "done" } });

    const whole = await read(taskId);
    expect(whole.notes).toHaveLength(4);
    expect(whole.history).toMatchObject([
      { event: "published", by: "you", client: "claude-code" },
      { event: "claimed", client: "claude-code" },
      { event: "handed_off", client: "claude-code" },
      { event: "claimed", by: "you", client: "antigravity" },
      { event: "done", client: "antigravity", session: expect.stringMatching(/^s-/) as string },
    ]);
    expect(ok(await call(second, "search_tasks", {})).tasks).toMatchObject([{ id: runbookId }]);
    expect(ok(await call(second, "search_tasks", { status: "done" })).tasks).toMatchObject([
      { id: taskId },
    ]);
  });

  test("a lease left alone expires and the task can be claimed; its old lease is then refused", async () => {
    const abandoned = ok(await call(first, "claim_task", { id: runbookId })).lease;
    expect(refused(await call(second, "claim_task", { id: runbookId })).code).toBe("lease_held");
    clock.advance(LEASE_MS);

    const listed = ok(await call(second, "search_tasks", { status: "open" }));
    const lapsed = { id: runbookId, state: "open", lapsed: true, holder: "you" };
    expect(listed.tasks).toMatchObject([{ ...lapsed, holder_client: "claude-code" }]);
    // The dashboard reads the same list: the task is open again, and it says whose lease ran out.
    const shown = async (status: string) =>
      (await (await server.api(`/api/tasks?status=${status}`)).json()) as TaskPage;
    expect(await shown("open")).toMatchObject({
      matched: 1,
      tasks: [{ ...lapsed, project: PROJECT, audience: "private" }],
    });
    expect(await shown("claimed")).toEqual({ tasks: [], matched: 0 });
    const taken = ok(await call(second, "claim_task", { id: runbookId }));
    expect(taken.task).toMatchObject({ state: "claimed", holder_client: "antigravity" });
    expect((await read(runbookId)).history).toMatchObject([{}, {}, { after: "lapsed" }]);
    const late = await call(first, "update_task", {
      id: runbookId,
      lease: abandoned,
      state: "done",
    });
    expect(refused(late).code).toBe("lease_held");

    const over = ok(await call(first, "claim_task", { id: runbookId, take_over: true }));
    expect(over.task).toMatchObject({ holder_client: "claude-code", held_by_this_session: true });
    const fenced = await call(second, "update_task", { id: runbookId, lease: taken.lease });
    expect(refused(fenced).code).toBe("lease_held");
  });

  test("a list is counted, cut and filtered, and shows the beginning of a long note", async () => {
    const project = "github.com/acme/ledger";
    const publish = async (title: string, more: Fields = {}) =>
      ok(await first.callTool("publish_task", { project, title, ...more }));
    const list = async (args: Fields) =>
      ok(await second.callTool("search_tasks", { project, ...args }));
    const step = await publish("Step 1: read the schema", { tracked: true, claim: true });
    await publish("Step 2: write the migration", { description: "Add the ledger columns." });
    await publish("Step 3: backfill the rows");
    const long = "Checked one more table of the ledger.".repeat(15);
    const id = String(step.task.id);
    ok(await first.callTool("update_task", { project, id, lease: step.lease, note: long }));

    const cut = await list({ limit: 2 });
    expect(cut).toMatchObject({
      matched: 3,
      shown: 2,
      tasks: [{ title: "Step 2: write the migration" }, { title: "Step 3: backfill the rows" }],
    });
    expect(cut.tasks[0]?.description).toBeUndefined();
    const held = await list({ status: "claimed", mine: true });
    expect(held).toMatchObject({ matched: 1, tasks: [{ id, tracked: true }] });
    expect(held.tasks[0]?.note).toBe(`${long.slice(0, 400).trimEnd()}…`);
    expect((await list({ id })).tasks[0]?.note).toBe(long);
    expect(await list({ status: "handed_off" })).toMatchObject({
      matched: 0,
      shown: 0,
      tasks: [],
      message: "no tasks match in this project",
    });
    const missing = await second.callTool("search_tasks", { project, id: randomUUID() });
    expect(refused(missing).code).toBe("not_found");
  });
});
