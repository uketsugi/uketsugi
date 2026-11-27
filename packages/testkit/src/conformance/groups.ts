import type { Caller, Store } from "@uketsugi/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FakeClock, FakeIdGen } from "../fakes.ts";
import { person, targetOf, type StoreHarness } from "./support.ts";

/**
 * What a Store must do for the groups of an organization: a unit reaches only the groups its
 * person is a member of, takes their heads in the order of their ids, and a removal from a group
 * or from the organization waits for a unit that holds the head.
 */
export function describeGroupConformance(name: string, harness: StoreHarness): void {
  describe(`${name}: groups`, () => {
    const clock = new FakeClock();
    const ids = new FakeIdGen(12);
    let store: Store;
    let alice: Caller;
    let carol: Caller;

    const asAlice = () => targetOf(alice, clock.now());

    beforeAll(async () => {
      store = await harness.open();
      alice = await person(store, ids, "test:alice");
      const seed = {
        subject: "test:carol",
        displayName: "carol",
        orgId: alice.orgId,
        principalId: ids.uuid(),
        audienceId: ids.uuid(),
      };
      await store.directory.addPerson(seed, ids.uuid(), []);
      const added = await store.directory.callerOf(alice.orgId, seed.principalId);
      if (added === null) throw new Error("carol was added");
      carol = added;
    });

    afterAll(() => store.close());

    test("a unit reaches only a group its person is a member of, and refuses another at once", async () => {
      const others = { id: ids.uuid(), name: "others-only" };
      expect(await store.directory.createGroup(alice.orgId, others)).toBe(true);
      await expect(store.unit(asAlice(), (unit) => unit.on(others.id))).rejects.toThrow(
        "a unit reaches only the groups its person is a member of",
      );
      await store.directory.addMember(alice.orgId, others.id, carol.principalId);
      await expect(store.unit(asAlice(), (unit) => unit.on(others.id))).rejects.toThrow(
        "a unit reaches only the groups its person is a member of",
      );
      await store.directory.addMember(alice.orgId, others.id, alice.principalId);
      await expect(store.unit(asAlice(), (unit) => unit.on(others.id))).resolves.toBeDefined();
    });

    test("a removal waits for a unit that holds the group's head, and a unit after it is refused", async () => {
      const group = { id: ids.uuid(), name: "removal-race" };
      await store.directory.createGroup(alice.orgId, group);
      await store.directory.addMember(alice.orgId, group.id, alice.principalId);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      let inside: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => (inside = resolve));
      const writing = store.unit(asAlice(), async (unit) => {
        await unit.on(group.id);
        inside();
        await held;
      });
      await entered;
      let removed = false;
      const removal = store.directory
        .removeMember(alice.orgId, group.id, alice.principalId)
        .then(() => (removed = true));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const early = removed;
      release();
      await writing;
      await removal;
      expect(early, "the removal went through while a unit held the group's head").toBe(false);
      await expect(store.unit(asAlice(), (unit) => unit.on(group.id))).rejects.toThrow(
        "a unit reaches only the groups its person is a member of",
      );
    });

    test("removing a person from the organization waits for a unit that holds the head of a group of theirs", async () => {
      // An organization of its own, so that its removed person is nobody's list but its own.
      const leaver = await person(store, ids, "test:leaver");
      const group = { id: ids.uuid(), name: "person-removal-race" };
      await store.directory.createGroup(leaver.orgId, group);
      await store.directory.addMember(leaver.orgId, group.id, leaver.principalId);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      let inside: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => (inside = resolve));
      const writing = store.unit(targetOf(leaver, clock.now()), async (unit) => {
        await unit.on(group.id);
        inside();
        await held;
      });
      await entered;
      let removed = false;
      const removal = store.directory
        .removePerson(leaver.orgId, leaver.principalId, clock.now())
        .then(() => (removed = true));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const early = removed;
      release();
      await writing;
      await removal;
      expect(early, "the removal went through while a unit held the group's head").toBe(false);
      expect(await store.directory.callerOf(leaver.orgId, leaver.principalId)).toBeNull();
    });

    test("a unit takes the heads of groups in the order of their ids, and refuses the reverse", async () => {
      const [first, second] = [
        { id: ids.uuid(), name: "order-first" },
        { id: ids.uuid(), name: "order-second" },
      ];
      for (const group of [first, second]) {
        await store.directory.createGroup(alice.orgId, group);
        await store.directory.addMember(alice.orgId, group.id, alice.principalId);
      }
      await expect(
        store.unit(asAlice(), async (unit) => {
          await unit.on(first.id);
          await unit.on(second.id);
        }),
      ).resolves.toBeUndefined();
      await expect(
        store.unit(asAlice(), async (unit) => {
          await unit.on(second.id);
          await unit.on(first.id);
        }),
      ).rejects.toThrow("a unit takes the heads of groups in the order of their ids");
    });
  });
}
