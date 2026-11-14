import {
  scopeOf,
  type Caller,
  type EventDraft,
  type Store,
  type Task,
  type TaskLease,
} from "@uketsugi/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FakeClock, FakeIdGen } from "../fakes.ts";
import { event, hash, openWithPeople, PROJECT, targetOf, type StoreHarness } from "./support.ts";

const LEASE_MS = 15 * 60_000;

/** What every Store adapter must do for tasks: versions, leases, notes, the log and scoping. */
export function describeTaskStoreConformance(name: string, harness: StoreHarness): void {
  describe(`${name}: Store conformance for tasks`, () => {
    const clock = new FakeClock();
    const ids = new FakeIdGen(11);
    let store: Store;
    let alice: Caller;
    let bob: Caller;

    const stepOf = (kind: EventDraft["kind"], subject: string, by: Caller) =>
      event(subject, by.principalId, kind, { version: 1 });
    const unitOf = (caller: Caller) => targetOf(caller, clock.now());

    function leaseOf(caller: Caller, token: string): TaskLease {
      const expiresAt = new Date(clock.now().getTime() + LEASE_MS);
      return { tokenHash: hash(token), holder: caller.principalId, session: ids.uuid(), expiresAt };
    }

    /** Publishes an open task with its event and returns it as stored. */
    async function publish(caller: Caller, title: string, project = PROJECT): Promise<Task> {
      const id = ids.uuid();
      const text = { title, description: "What is to be done.", tracked: false };
      const stored = await store.unit(unitOf(caller), async (unit) => {
        await unit.tasks.insert({
          id,
          project,
          ...text,
          publisher: caller.principalId,
          lease: null,
        });
        await unit.append(stepOf("TaskPublished", id, caller));
        return unit.tasks.get(id);
      });
      if (stored === null) throw new Error("a task was not readable inside its own unit");
      return stored;
    }

    beforeAll(async () => {
      ({ store, alice, bob } = await openWithPeople(harness, ids));
    });
    afterAll(() => store.close());

    test("a task is published open at version 1 and found by its title until it is done", async () => {
      const task = await publish(alice, "Remove legacy dunning");
      expect(task).toMatchObject({
        state: "open",
        version: 1,
        lease: null,
        publisher: alice.principalId,
        createdAt: clock.now(),
      });
      const find = () =>
        store.unit(unitOf(alice), (unit) =>
          unit.tasks.findOpenByTitle(alice.principalId, PROJECT, "Remove legacy dunning"),
        );
      expect((await find())?.id).toBe(task.id);
      await store.unit(unitOf(alice), (unit) => unit.tasks.change(task.id, 1, { state: "done" }));
      expect(await find()).toBeNull();
    });

    test("a change applies only at the version it names", async () => {
      const task = await publish(alice, "Queue-backed retries");
      const lease = leaseOf(alice, "t1");
      const [claimed, stale] = await store.unit(unitOf(alice), async (unit) => [
        await unit.tasks.change(task.id, 1, { state: "claimed", lease }),
        await unit.tasks.change(task.id, 1, { state: "done", lease: null }),
      ]);
      expect(claimed).toMatchObject({ state: "claimed", version: 2, lease });
      expect(stale).toBeNull();
      expect(await store.tasks.get(scopeOf(alice), task.id)).toMatchObject({
        state: "claimed",
        version: 2,
        lease,
      });
    });

    test("a renewal moves the lease's end and nothing else; a freed lease is gone", async () => {
      const task = await publish(alice, "Rotate the signing key");
      const lease = leaseOf(alice, "t2");
      await store.unit(unitOf(alice), (unit) =>
        unit.tasks.change(task.id, 1, { state: "claimed", lease }),
      );
      const claimedAt = clock.now();
      clock.advance(60_000);
      const later = new Date(clock.now().getTime() + LEASE_MS);
      const renewed = await store.unit(unitOf(alice), (unit) => unit.tasks.renew(task.id, later));
      expect(renewed).toMatchObject({
        version: 2,
        updatedAt: claimedAt,
        lease: { ...lease, expiresAt: later },
      });
      const freed = await store.unit(unitOf(alice), async (unit) => {
        const released = await unit.tasks.change(task.id, 2, { state: "open", lease: null });
        return [released, await unit.tasks.renew(task.id, later)];
      });
      expect(freed[0]).toMatchObject({ state: "open", version: 3, lease: null });
      expect(freed[1]).toBeNull();
    });

    test("notes are only added, each with its author, session and time", async () => {
      const first = await publish(alice, "Migrate the ledger");
      const second = await publish(alice, "Archive old invoices");
      const from = { author: alice.principalId, session: ids.uuid() };
      const note = (taskId: string, kind: "note" | "handoff", text: string) =>
        store.unit(unitOf(alice), async (unit) => {
          await unit.tasks.addNote({ taskId, id: ids.uuid(), kind, ...from, text });
          return unit.tasks.lastNote(taskId);
        });
      expect(await note(first.id, "note", "Schema written")).toMatchObject({
        text: "Schema written",
        at: clock.now(),
      });
      clock.advance(1000);
      const handoff = await note(first.id, "handoff", "Left: backfill the rows");
      expect(handoff).toMatchObject({ kind: "handoff", ...from, at: clock.now() });
      await note(second.id, "note", "Nothing archived yet");

      const all = await store.tasks.notes(scopeOf(alice), [first.id]);
      expect(all.map((entry) => entry.text)).toEqual(["Schema written", "Left: backfill the rows"]);
      const latest = await store.tasks.latestNotes(scopeOf(alice), [first.id, second.id]);
      expect(latest.map((entry) => entry.text).sort()).toEqual([
        "Left: backfill the rows",
        "Nothing archived yet",
      ]);
      expect((await store.tasks.get(scopeOf(alice), first.id))?.version).toBe(1);
    });

    test("one unit commits a change with its note and event, and the log reads back in order", async () => {
      const task = await publish(alice, "Split the billing worker");
      const lease = leaseOf(alice, "t3");
      const text = { kind: "note" as const, text: "Half way" };
      const from = { author: alice.principalId, session: ids.uuid() };
      const note = { taskId: task.id, id: ids.uuid(), ...from, ...text };
      await store.unit(unitOf(alice), async (unit) => {
        await unit.tasks.change(task.id, 1, { state: "claimed", lease });
        await unit.append(stepOf("TaskClaimed", task.id, alice));
      });
      const failed = store.unit(unitOf(alice), async (unit) => {
        await unit.tasks.change(task.id, 2, { state: "done", lease: null });
        await unit.tasks.addNote(note);
        await unit.append(stepOf("TaskDone", task.id, alice));
        throw new Error("stop");
      });
      await expect(failed).rejects.toThrow("stop");
      expect(await store.tasks.get(scopeOf(alice), task.id)).toMatchObject({
        state: "claimed",
        version: 2,
      });
      expect(await store.tasks.notes(scopeOf(alice), [task.id])).toEqual([]);
      const history = await store.tasks.history(scopeOf(alice), task.id);
      expect(history.map((step) => step.kind)).toEqual(["TaskPublished", "TaskClaimed"]);
      expect(history[1]).toMatchObject({
        actor: { kind: "person", id: alice.principalId },
        payload: { version: 1 },
      });
      expect(history[0]?.seq).toBeLessThan(history[1]?.seq ?? 0);
    });

    test("a listing filters by project, state and person, and the count agrees", async () => {
      const other = "github.com/acme/other";
      const mine = await publish(alice, "Only here", other);
      const held = await publish(alice, "Held here", other);
      await store.unit(unitOf(alice), (unit) =>
        unit.tasks.change(held.id, 1, { state: "claimed", lease: leaseOf(alice, "t4") }),
      );
      const scope = scopeOf(alice);
      const all = await store.tasks.list(scope, { project: other, limit: 10 });
      expect(all.map((task) => task.id).sort()).toEqual([mine.id, held.id].sort());
      const claimed = { project: other, states: ["claimed" as const] };
      expect((await store.tasks.list(scope, { ...claimed, limit: 10 })).map((t) => t.id)).toEqual([
        held.id,
      ]);
      expect(await store.tasks.count(scope, claimed)).toBe(1);
      expect(await store.tasks.count(scope, { project: other, person: alice.principalId })).toBe(2);
      expect(await store.tasks.count(scope, { project: other, person: bob.principalId })).toBe(0);
      expect(await store.tasks.list(scope, { project: other, limit: 1 })).toHaveLength(1);
      // Without a project a listing holds every project's tasks, most recently changed first.
      const everywhere = await store.tasks.list(scope, { limit: 100 });
      expect(new Set(everywhere.map((task) => task.project))).toEqual(new Set([PROJECT, other]));
      expect(everywhere.slice(0, 2).map((task) => task.id)).toEqual([held.id, mine.id]);
      expect(await store.tasks.count(scope, {})).toBe(everywhere.length);
      expect(await store.tasks.count(scope, { states: ["claimed"] })).toBeGreaterThan(1);
    });

    test("a task outside the reader's organization and audiences reads as absent", async () => {
      const task = await publish(alice, "Private to Alice");
      await store.unit(unitOf(alice), (unit) =>
        unit.tasks.addNote({
          taskId: task.id,
          id: ids.uuid(),
          kind: "note",
          author: alice.principalId,
          session: ids.uuid(),
          text: "Not for Bob",
        }),
      );
      const outside = [
        scopeOf(bob),
        { orgId: alice.orgId, audienceIds: [bob.privateAudienceId] },
        { orgId: alice.orgId, audienceIds: [] },
      ];
      for (const scope of outside) {
        expect(await store.tasks.get(scope, task.id)).toBeNull();
        expect(await store.tasks.list(scope, { project: PROJECT, limit: 10 })).toEqual([]);
        expect(await store.tasks.count(scope, { project: PROJECT })).toBe(0);
        expect(await store.tasks.notes(scope, [task.id])).toEqual([]);
        expect(await store.tasks.latestNotes(scope, [task.id])).toEqual([]);
        expect(await store.tasks.history(scope, task.id)).toEqual([]);
      }
      const inBobsUnit = await store.unit(unitOf(bob), async (unit) => [
        await unit.tasks.get(task.id),
        await unit.tasks.change(task.id, 1, { state: "done" }),
        await unit.tasks.lastNote(task.id),
      ]);
      expect(inBobsUnit).toEqual([null, null, null]);
    });
  });
}
