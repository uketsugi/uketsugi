/**
 * What a person does to what is stored, as the use cases do it, on each store: removing a
 * session's note, correcting and confirming a fact, closing a task, deleting a project.
 */
import {
  closeTask,
  confirmFact,
  correctFact,
  deleteProject,
  projectContents,
  removeNote,
  SESSION_IDLE_MS,
} from "@uketsugi/core";
import { expect, test } from "vitest";
import { candidate, FOUND, scripted, serverWith } from "./digest-world.ts";
import { describeUseCases } from "./use-case-world.ts";

describeUseCases("a person's own corrections", (w) => {
  const { clock } = w;

  /** A fact a model wrote from a session that ended, as the facts of the project the server has. */
  async function modelWrote(claim: string) {
    const runner = scripted({
      extract: () => ({ facts: [candidate(claim, ["src/queue/retry.ts:40"])] }),
    });
    const server = serverWith(w, runner);
    await server.end(FOUND);
    await server.drain();
    const [fact] = await w.store.facts.list(w.scope, { project: server.project, limit: 5 });
    if (fact === undefined) throw new Error("the model wrote nothing");
    return { server, fact };
  }

  test("removing a session's note takes the note and the turns kept to read, and nothing is left for the model to read", async () => {
    const runner = scripted({});
    const server = serverWith(w, runner);
    await server.call("search_facts", { query: "anything" });
    await server.turn({ request: "please look at the retry path" });
    await server.note(FOUND);
    const before = await server.session();
    expect(before.note?.text).toBe(FOUND.slice(0, before.note?.text.length));
    expect(await w.store.sessions.turns(w.owner.orgId, before.id)).toHaveLength(1);

    const removed = await removeNote(server.ports, w.owner, before.displayId);
    expect(removed).toEqual({ session: before.displayId });
    const after = await server.session();
    expect(after.note).toBeNull();
    expect(await w.store.sessions.turns(w.owner.orgId, after.id)).toEqual([]);

    // What was armed to read the session finds nothing to ask a model about.
    clock.advance(SESSION_IDLE_MS + 1);
    await server.drain();
    expect(runner.askedFor("digest.extract")).toEqual([]);
    // A session that is not the person's own, or not there, is not found.
    await expect(removeNote(server.ports, w.owner, "s-0000")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("a person's correction replaces the words a model wrote, as theirs, and agents are given them", async () => {
    const { server, fact } = await modelWrote("The webhook queue retries five times with backoff");
    expect(fact.digestSession).not.toBeNull();
    const corrected = await correctFact(server.ports, w.owner, fact.id, {
      claim: "The webhook queue retries three times with backoff",
      detail: null,
    });
    expect(corrected).toEqual({ id: fact.id, changed: true });
    const now = await w.factOf(fact.id);
    expect(now.claim).toBe("The webhook queue retries three times with backoff");
    expect(now.digestSession).toBeNull();
    const [event] = (await w.eventsOf(fact.id)).filter((entry) => entry.kind === "FactRewritten");
    expect(event).toMatchObject({
      actor: { kind: "person", id: w.owner.principalId },
      session: null,
    });
    const found = await server.call("search_facts", { query: "webhook queue retries" });
    expect(found.facts.map((entry) => entry.claim)).toEqual([now.claim]);
    // The same words again change nothing; a secret in them is replaced as in any write.
    expect(
      await correctFact(server.ports, w.owner, fact.id, { claim: now.claim ?? "" }),
    ).toMatchObject({
      changed: false,
    });
    const secret = `ghp_${"16C7e42F292c6912E7710c838347Ae178B4a"}`;
    const scanned = await correctFact(server.ports, w.owner, fact.id, {
      claim: `Token is ${secret}`,
    });
    expect(scanned.redacted).toHaveLength(1);
    expect((await w.factOf(fact.id)).claim).not.toContain(secret);
  });

  test("a person confirms a fact a model wrote, and it stands as confirmed, still saying a model wrote it", async () => {
    const { server, fact } = await modelWrote("Deliveries are deduplicated on the event id");
    expect(fact.status).toBe("unconfirmed");
    const confirmed = await confirmFact(server.ports, w.owner, fact.id, {
      checked: "read dedupe.ts",
    });
    expect(confirmed).toEqual({ id: fact.id, status: "confirmed" });
    expect(await w.factOf(fact.id)).toMatchObject({
      status: "confirmed",
      digestSession: fact.digestSession,
    });
    await expect(confirmFact(server.ports, w.owner, "not-a-fact", {})).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("a person closes a task held under a lease: it is done, the lease is free, and it leaves the brief's open tasks", async () => {
    const server = serverWith(w, undefined);
    await server.call("publish_task", { title: "Backfill the audit column" });
    const claimed = await server.call("claim_task", { id: (await openTask(server)).id });
    expect(claimed.task.state).toBe("claimed");
    const id = claimed.task.id;
    expect(await closeTask(server.ports, w.owner, id)).toEqual({ id, changed: true });
    const task = await w.store.tasks.get(w.scope, id);
    expect(task).toMatchObject({ state: "done", lease: null });
    const steps = await w.store.tasks.history(w.scope, id);
    expect(steps.at(-1)).toMatchObject({
      kind: "TaskDone",
      actor: { id: w.owner.principalId },
      session: null,
    });
    expect(await closeTask(server.ports, w.owner, id)).toEqual({ id, changed: false });
    clock.advance(SESSION_IDLE_MS + 1);
    const next = await server.another("search_tasks", {});
    expect(next.tasks).toEqual([]);
  });

  test("deleting a project takes the person's facts, tasks, sessions and what the logs hold of them, and flags what elsewhere cited them", async () => {
    const server = serverWith(w, undefined);
    const gone = await server.call("publish_fact", {
      claim: "Billing reads the ledger by name",
      citations: "src/a.ts:1",
    });
    await server.call("publish_task", { title: "Rename nothing" });
    await server.note(FOUND);
    const elsewhere = await w.publish("The report job reads billing's ledger", [
      { kind: "fact", fact: gone.id },
    ]);
    const shown = await projectContents(server.ports, w.owner, { project: server.project });
    expect(shown).toMatchObject({
      facts: 1,
      tasks: 1,
      sessions: 1,
      others_facts: 0,
      others_tasks: 0,
    });

    const deleted = await deleteProject(server.ports, w.owner, { project: server.project });
    expect(deleted).toMatchObject({ facts: 1, tasks: 1, sessions: 1 });
    expect(await w.store.facts.get(w.scope, gone.id)).toBeNull();
    expect(await w.eventsOf(gone.id)).toEqual([]);
    expect(await w.store.tasks.list(w.scope, { project: server.project, limit: 5 })).toEqual([]);
    expect(
      await w.store.sessions.latest(w.owner.orgId, w.owner.principalId, server.project),
    ).toBeNull();
    // The fact that cited it stays, and says its source changed.
    expect(await w.flagsOf(elsewhere.id)).toContain("source_changed");
    await expect(
      projectContents(server.ports, w.owner, { project: server.project }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

/** The one open task of the server's project, as a search lists it. */
async function openTask(server: ReturnType<typeof serverWith>) {
  const { tasks } = await server.call("search_tasks", {});
  const [task] = tasks;
  if (task === undefined) throw new Error("the project has no task");
  return task;
}
