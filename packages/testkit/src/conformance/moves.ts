import { replaceTokens, scopeOf, type Caller, type Store, type UnitTarget } from "@uketsugi/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FakeClock, FakeIdGen } from "../fakes.ts";
import { content, event, person, PROJECT, targetOf, type StoreHarness } from "./support.ts";

/**
 * What a Store must do for a server of several people: one shared audience per organization that
 * all its callers see, a person's own choice per project, read and written under that person's
 * lock, and a move that takes a record between a person's audience and the shared one with
 * everything that hangs off it while the log stays where it was written.
 */
export function describeMoveConformance(name: string, harness: StoreHarness): void {
  describe(`${name}: sharing and moves`, () => {
    const clock = new FakeClock();
    const ids = new FakeIdGen(11);
    let store: Store;
    let alice: Caller;
    let carol: Caller;
    let stranger: Caller;
    let shared: string;

    /** The same person, read again: what a later request of theirs is resolved to. */
    const again = (subject: string, orgId: string): Promise<Caller> =>
      store.directory.ensurePrincipal({
        subject,
        displayName: subject.replace("test:", ""),
        orgId,
        principalId: ids.uuid(),
        audienceId: ids.uuid(),
      });

    const onShared = (): UnitTarget => ({
      orgId: alice.orgId,
      audienceId: shared,
      at: clock.now(),
    });
    const asAlice = (): UnitTarget => targetOf(alice, clock.now());
    const logOf = (audienceId: string) =>
      store.review.events({ orgId: alice.orgId, audienceIds: [audienceId] }, audienceId, 0, 100);

    beforeAll(async () => {
      store = await harness.open();
      alice = await person(store, ids, "test:alice");
      stranger = await person(store, ids, "test:stranger");
    });

    afterAll(() => store.close());

    test("a person is added whole or not at all: with their credentials, and the one shared audience each of the organization's people then sees", async () => {
      const { directory } = store;
      expect(alice).toMatchObject({ sharedAudienceId: null, credentialId: null });
      expect(alice.visibleAudienceIds).toEqual([alice.privateAudienceId]);
      const joining = (name: string) => {
        const seed = {
          subject: `test:${name}`,
          displayName: name,
          orgId: alice.orgId,
          principalId: ids.uuid(),
          audienceId: ids.uuid(),
        };
        const credential = {
          orgId: alice.orgId,
          id: ids.uuid(),
          principalId: seed.principalId,
          kind: "agent" as const,
          label: `${name}'s token`,
          tokenHash: ids.uuid().replaceAll("-", "").repeat(2),
          createdAt: clock.now(),
        };
        return { seed, credential };
      };
      // The second credential cannot be stored: nothing of the person or of sharing is left behind.
      const cut = joining("carol");
      await expect(
        directory.addPerson(cut.seed, ids.uuid(), [cut.credential, cut.credential]),
      ).rejects.toThrow();
      expect((await directory.people(alice.orgId)).map((entry) => entry.id)).toEqual([
        alice.principalId,
      ]);
      expect((await again("test:alice", alice.orgId)).sharedAudienceId).toBeNull();
      const { seed, credential } = joining("carol");
      await directory.addPerson(seed, ids.uuid(), [credential]);
      expect(await directory.credentials(alice.orgId, seed.principalId)).toMatchObject([
        { id: credential.id, kind: "agent", revokedAt: null },
      ]);
      alice = await again("test:alice", alice.orgId);
      carol = await again("test:carol", alice.orgId);
      shared = alice.sharedAudienceId ?? "";
      // The next person joins the audience that is there, whatever id their invitation carried.
      await directory.addPerson(joining("dave").seed, ids.uuid(), []);
      expect((await again("test:dave", alice.orgId)).sharedAudienceId).toBe(shared);
      expect(alice.visibleAudienceIds).toEqual([alice.privateAudienceId, shared]);
      expect(carol).toMatchObject({ orgId: alice.orgId, sharedAudienceId: shared });
      expect(carol.privateAudienceId).not.toBe(alice.privateAudienceId);
      expect((await again("test:stranger", stranger.orgId)).sharedAudienceId).toBeNull();
      const people = await store.directory.people(alice.orgId);
      expect(people.map((entry) => entry.displayName)).toEqual(["test:alice", "carol", "dave"]);
      await store.directory.rename(alice.orgId, alice.principalId, "alice");
      expect((await again("test:alice", alice.orgId)).displayName).toBe("alice");
    });

    test("a person's choice for a project is theirs: kept, replaced, and listed with their own projects only", async () => {
      const { projects } = store;
      const [here, named] = [PROJECT, "me/notes"];
      await projects.ensure(alice.orgId, { kind: "repository", key: here });
      await projects.ensure(alice.orgId, { kind: "named", key: named });
      const of = (who: Caller) => [who.orgId, who.principalId] as const;
      expect(await projects.choice(...of(alice), here)).toBeNull();
      await projects.choose(...of(alice), here, "shared");
      await projects.choose(...of(alice), named, "private", "Notes");
      await projects.choose(...of(alice), named, "private");
      expect(await projects.choice(...of(alice), here)).toBe("shared");
      await projects.choose(...of(alice), here, "private");
      expect(await projects.listOf(...of(alice))).toMatchObject([
        { key: here, choice: "private", displayName: null },
        { key: named, choice: "private", displayName: "Notes" },
      ]);
      expect(await projects.listOf(...of(carol))).toEqual([]);
      expect(await projects.choice(...of(carol), here)).toBeNull();
    });

    test("a move takes a fact with its chain and all that hangs off it, a task with its notes, and leaves the log", async () => {
      const own = targetOf(alice, clock.now());
      const [old, live, task, ruling] = [ids.uuid(), ids.uuid(), ids.uuid(), ids.uuid()];
      const by = { kind: "person" as const, id: alice.principalId };
      const author = alice.principalId;
      await store.unit(own, async (unit) => {
        for (const id of [old, live]) {
          const draft = { id, project: PROJECT, author, vector: null };
          await unit.facts.insert({ ...draft, content: content(`Retries stop after five: ${id}`) });
          await unit.append(event(id, author));
        }
        await unit.facts.supersede(old, live);
        await unit.review.record({
          id: ruling,
          decision: "merge_duplicate",
          factId: old,
          decidedBy: by,
          reasons: ["same_words"],
        });
        const check = { person: carol.principalId, at: clock.now(), sourceVersion: null };
        await unit.review.confirm({ factId: live, ...check, checked: "read it" });
        await unit.review.raiseFlag({
          id: ids.uuid(),
          factId: live,
          kind: "marked_stale",
          raisedBy: by,
        });
        await unit.enqueue({ id: ids.uuid(), kind: "embed", subject: live, runAfter: clock.now() });
        const draft = { id: task, project: PROJECT, title: "Move the schedule", description: null };
        await unit.tasks.insert({ ...draft, tracked: false, publisher: author, lease: null });
        const note = { taskId: task, id: ids.uuid(), kind: "note" as const, author };
        await unit.tasks.addNote({ ...note, session: ids.uuid(), text: "Half done." });
        await unit.append(event(task, author, "TaskPublished"));
      });
      const before = await logOf(alice.privateAudienceId);
      clock.advance(60_000);

      const moved = await store.unit(asAlice(), async (unit) => {
        const everyone = await unit.on(shared);
        const move = { from: alice.privateAudienceId, to: shared, facts: [live], tasks: [task] };
        const went = await unit.move(move);
        await unit.append(event(live, author, "FactShared", { left: true }));
        await everyone.append(event(live, author, "FactShared"));
        // Inside the unit the record is where it went, and nowhere else.
        expect((await everyone.facts.behind(live)).map((fact) => fact.id)).toEqual([old]);
        expect(await everyone.facts.writtenBy(author, PROJECT)).toHaveLength(2);
        expect(await unit.facts.getMany([old, live])).toEqual([]);
        expect((await everyone.tasks.publishedBy(author, PROJECT)).map((t) => t.id)).toEqual([
          task,
        ]);
        return went;
      });
      expect({ facts: [...moved.facts].sort(), tasks: moved.tasks }).toEqual({
        facts: [old, live].sort(),
        tasks: [task],
      });

      const everyone = scopeOf(carol);
      const mine = { orgId: alice.orgId, audienceIds: [alice.privateAudienceId] };
      expect(
        (await store.facts.getMany(everyone, [old, live])).map((fact) => fact.audienceId),
      ).toEqual([shared, shared]);
      expect(await store.facts.getMany(mine, [old, live])).toEqual([]);
      expect(await store.facts.heads(everyone, [old])).toEqual(new Map([[old, live]]));
      expect(await store.review.confirmations(everyone, [live])).toMatchObject([
        { audienceId: shared, person: carol.principalId },
      ]);
      expect(await store.review.openFlags(everyone, [live])).toMatchObject([
        { audienceId: shared },
      ]);
      expect(await store.review.rulingsOf(everyone, [old])).toMatchObject([
        { id: ruling, audienceId: shared },
      ]);
      expect((await store.tasks.get(everyone, task))?.audienceId).toBe(shared);
      expect(await store.tasks.notes(everyone, [task])).toMatchObject([{ text: "Half done." }]);
      expect(await store.tasks.get(mine, task)).toBeNull();
      const jobs = await store.jobs.claim(clock.now(), 1000, 10);
      expect(jobs).toMatchObject([{ subject: live, audienceId: shared }]);

      // The log: what was written stays, and the move is one new entry in each log.
      const left = await logOf(alice.privateAudienceId);
      expect(left.slice(0, before.length)).toEqual(before);
      expect(left.slice(before.length)).toMatchObject([
        { seq: before.length + 1, kind: "FactShared", subject: live, payload: { left: true } },
      ]);
      expect(await logOf(shared)).toMatchObject([{ seq: 1, kind: "FactShared", subject: live }]);
      // Read by its subject, a record's history is whatever the reader's logs hold of it.
      const kinds = async (scope: typeof everyone) =>
        (await store.review.history(scope, live, 10)).map((entry) => entry.kind);
      expect(await kinds(everyone)).toEqual(["FactShared"]);
      expect(await kinds(scopeOf(alice))).toEqual(["FactShared", "FactShared", "FactPublished"]);
    });

    test("the shared audience is reached only from a person's own unit, so no two units wait for each other", async () => {
      const refused = "only a unit opened on a person's own audience";
      await expect(
        store.unit(onShared(), (unit) => unit.on(alice.privateAudienceId)),
      ).rejects.toThrow(refused);
      await expect(store.unit(onShared(), (unit) => unit.choice(PROJECT))).rejects.toThrow(refused);
      await expect(
        store.unit(asAlice(), (unit) => unit.on(carol.privateAudienceId)),
      ).rejects.toThrow("a unit reaches no audience but its organization's shared one");
      const elsewhere = { from: alice.privateAudienceId, to: carol.privateAudienceId };
      await expect(
        store.unit(asAlice(), (unit) => unit.move({ ...elsewhere, facts: [], tasks: [] })),
      ).rejects.toThrow("a move runs to or from the shared audience the unit has reached");
      const toShared = { from: alice.privateAudienceId, to: shared, facts: [], tasks: [] };
      await expect(store.unit(asAlice(), (unit) => unit.move(toShared))).rejects.toThrow(
        "a move runs to or from the shared audience the unit has reached",
      );
      expect(await logOf(carol.privateAudienceId)).toEqual([]);
    });

    test("a choice made in a unit is that person's, and commits or fails with the unit", async () => {
      const key = "github.com/acme/chosen-in-a-unit";
      await store.projects.ensure(alice.orgId, { kind: "repository", key });
      const mine = [alice.orgId, alice.principalId, key] as const;
      await store.unit(asAlice(), async (unit) => {
        expect(await unit.choice(key)).toBeNull();
        await unit.choose(key, "shared");
        expect(await unit.choice(key)).toBe("shared");
      });
      expect(await store.projects.choice(...mine)).toBe("shared");
      expect(await store.projects.choice(carol.orgId, carol.principalId, key)).toBeNull();
      const failed = store.unit(asAlice(), async (unit) => {
        await unit.choose(key, "private");
        throw new Error("the move that follows the choice failed");
      });
      await expect(failed).rejects.toThrow("the move that follows");
      expect(await store.projects.choice(...mine)).toBe("shared");
    });

    test("a record its source does not hold is left where it is", async () => {
      const id = ids.uuid();
      const draft = { id, project: PROJECT, author: carol.principalId, vector: null };
      await store.unit(targetOf(carol, clock.now()), (unit) =>
        unit.facts.insert({ ...draft, content: content("Carol's own fact") }),
      );
      const moved = await store.unit(asAlice(), async (unit) => {
        await unit.on(shared);
        return unit.move({ from: alice.privateAudienceId, to: shared, facts: [id], tasks: [id] });
      });
      expect(moved).toEqual({ facts: [], tasks: [] });
      expect((await store.facts.get(scopeOf(carol), id))?.audienceId).toBe(carol.privateAudienceId);
    });

    test("rotations at once leave exactly one live agent token, and each says how many it ended", async () => {
      const ports = { store, clock, ids };
      const before = await replaceTokens(ports, alice);
      const rotated = await Promise.all(
        Array.from({ length: 5 }, () => replaceTokens(ports, alice)),
      );
      const held = await store.directory.credentials(alice.orgId, alice.principalId);
      const live = held.filter(({ kind, revokedAt }) => kind === "agent" && revokedAt === null);

      expect(before.revoked).toBe(0);
      expect(live).toHaveLength(1);
      // Each token but the last was ended by a later rotation, and the ones it ended add up.
      expect(rotated.reduce((sum, { revoked }) => sum + revoked, 0)).toBe(5);
      expect(new Set(rotated.map(({ token }) => token)).size).toBe(5);
    });

    test("a removed person leaves the people and every credential of theirs ends, and their name is still known to what they shared", async () => {
      const { directory } = store;
      const seed = {
        subject: "test:erin",
        displayName: "erin",
        orgId: alice.orgId,
        principalId: ids.uuid(),
        audienceId: ids.uuid(),
      };
      const secrets = new Map<string, string>();
      const credential = (kind: "agent" | "person") => {
        const tokenHash = ids.uuid().replaceAll("-", "").repeat(2);
        secrets.set(kind, tokenHash);
        return {
          orgId: alice.orgId,
          id: ids.uuid(),
          principalId: seed.principalId,
          kind,
          label: kind,
          tokenHash,
          createdAt: clock.now(),
        };
      };
      await directory.addPerson(seed, ids.uuid(), [credential("agent"), credential("person")]);
      const listed = async () =>
        (await directory.people(alice.orgId)).map((entry) => entry.displayName);
      expect(await listed()).toContain("erin");

      expect(await directory.removePerson(alice.orgId, seed.principalId, clock.now())).toBe(2);

      expect(await listed()).not.toContain("erin");
      expect(
        (await directory.removedPeople(alice.orgId)).map((entry) => entry.displayName),
      ).toEqual(["erin"]);
      for (const kind of ["agent", "person"] as const)
        expect(
          await directory.callerByTokenHash(secrets.get(kind) ?? "", kind, clock.now()),
        ).toBeNull();
      const held = await directory.credentials(alice.orgId, seed.principalId);
      expect(held.every((entry) => entry.revokedAt !== null)).toBe(true);
      const names = await directory.names(alice.orgId, [seed.principalId]);
      expect(names.get(seed.principalId)).toBe("erin");
      expect(await directory.removePerson(alice.orgId, seed.principalId, clock.now())).toBe(0);
    });
  });
}
