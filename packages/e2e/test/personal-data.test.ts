/**
 * A person's own data on a server of two people: taking all of it away, and having all of it
 * deleted. Bob's words carry BOBMARK and Ann's ANNMARK, so that what is found where can be said.
 */
import { AFTER_DELETION } from "@uketsugi/contracts";
import {
  accountContents,
  deleteAccount,
  exportMine,
  removeFromGroup,
  renderMine,
  scopeOf,
} from "@uketsugi/core";
import { expect, test } from "vitest";
import { groupsWorld, P } from "./groups-world.ts";
import { CHECKABLE, sharedWorld } from "./sharing-world.ts";
import { describeUseCases } from "./use-case-world.ts";

describeUseCases("a person's own data", (w) => {
  const s = sharedWorld(w);
  let projects = 0;

  /** Both share a project; each publishes a fact and a task, Bob's fact cites Ann's, and Bob notes Ann's task. */
  async function setUp() {
    projects += 1;
    const PROJECT = `github.com/acme/personal-${projects}`;
    await s.choose(s.ann, PROJECT, "shared");
    await s.choose(s.bob, PROJECT, "shared");
    const [ann, bob] = [s.calls(s.ann, PROJECT), s.calls(s.bob, PROJECT)];
    const annFact = await ann("publish_fact", {
      claim: `ANNMARK retries stop at five ${projects}`,
      citations: CHECKABLE,
    });
    const bobFact = await bob("publish_fact", {
      claim: `BOBMARK backoff doubles ${projects}`,
      citations: [{ kind: "fact", fact: annFact.id }, CHECKABLE],
    });
    const annTask = await ann("publish_task", { title: `ANNMARK task ${projects}` });
    const bobTask = await bob("publish_task", { title: `BOBMARK task ${projects}` });
    const claimed = await bob("claim_task", { id: annTask.task.id });
    await bob("update_task", {
      id: annTask.task.id,
      lease: claimed.lease,
      note: "BOBMARK note on Ann's task",
    });
    return {
      PROJECT,
      ann,
      bob,
      annFact,
      bobFact,
      annTask: annTask.task.id,
      bobTask: bobTask.task.id,
    };
  }

  test("a person takes everything they wrote, and nothing another person wrote", async () => {
    const { PROJECT, bobFact, bobTask } = await setUp();
    const mine = await exportMine(s.ports, s.bob);
    expect(mine.version).toBe(1);
    expect(mine.facts.map((fact) => fact.id)).toContain(bobFact.id);
    expect(mine.tasks.map((task) => task.id)).toContain(bobTask);
    expect(mine.task_notes.map((note) => note.text)).toContain("BOBMARK note on Ann's task");
    expect(mine.projects.map((project) => project.key)).toContain(PROJECT);
    const whole = JSON.stringify(mine);
    expect(whole).not.toContain("ANNMARK");
    expect(whole).not.toMatch(/token|hash|vector/i);
    const readable = renderMine(mine);
    expect(readable).toContain("BOBMARK backoff doubles");
    expect(readable).toContain("BOBMARK task");
    expect(readable).toContain("BOBMARK note on Ann's task");
    expect(readable).not.toContain("ANNMARK");
  });

  test("the account shows what goes and what stays before it goes", async () => {
    const { PROJECT } = await setUp();
    const shown = await accountContents(s.ports, s.bob);
    expect(shown.facts).toBeGreaterThanOrEqual(1);
    expect(shown.tasks).toBeGreaterThanOrEqual(1);
    expect(shown.task_notes).toBeGreaterThanOrEqual(1);
    expect(shown.blocked).toBeNull();
    expect(shown.groups).toContainEqual(
      expect.objectContaining({ name: "everyone", other_members: 1 }),
    );
    expect(shown.others_facts).toBeGreaterThanOrEqual(1);
    expect(shown.others_tasks).toBeGreaterThanOrEqual(1);
    expect(PROJECT).toContain("personal-");
  });

  test("the organization's administrator is refused while others are in it, and a wrong name is refused", async () => {
    await setUp();
    expect((await accountContents(s.ports, s.ann)).blocked).toMatch(/Remove them/);
    await expect(deleteAccount(s.ports, s.ann, { name: s.ann.displayName })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(deleteAccount(s.ports, s.bob, { name: "somebody else" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(await exportMine(s.ports, s.ann)).toMatchObject({ version: 1 });
  });

  test("deleting an account takes everything the person wrote, in their group too, and nothing of anyone else's", async () => {
    const { ann, annFact, bobFact, annTask, bobTask } = await setUp();
    const bobName = s.bob.displayName;
    const gone = await deleteAccount(s.ports, s.bob, { name: bobName });
    expect(gone.facts).toBeGreaterThanOrEqual(1);
    expect(gone.tasks).toBeGreaterThanOrEqual(1);

    // Nobody finds it: not by id, not by a search, not in a list, not in anyone's export.
    expect(await s.seenBy(s.ann, bobFact.id)).toBeNull();
    expect(await s.ports.store.tasks.get(s.everyone(), bobTask)).toBeNull();
    const found = await ann("search_facts", { query: "BOBMARK backoff doubles" });
    expect(JSON.stringify(found)).not.toContain("BOBMARK");
    expect(JSON.stringify(await exportMine(s.ports, s.ann))).not.toContain("BOBMARK");

    // What others wrote stays, and what rested on Bob's fact says it changed. Bob's notes on Ann's task went.
    expect(await s.seenBy(s.ann, annFact.id)).not.toBeNull();
    expect(await s.ports.store.tasks.get(s.everyone(), annTask)).not.toBeNull();
    expect(await s.ports.store.tasks.notes(s.everyone(), [annTask])).toEqual([]);

    // He cannot sign in, and what is left of the account names nobody.
    expect(await s.ports.store.directory.callerOf(s.bob.orgId, s.bob.principalId)).toBeNull();
    const [left] = (await s.ports.store.directory.removedPeople(s.bob.orgId)).filter(
      (person) => person.id === s.bob.principalId,
    );
    expect(left?.displayName).toBe("deleted account");
    expect(await s.ports.store.directory.credentials(s.bob.orgId, s.bob.principalId)).toEqual([]);

    // The log keeps no content of his: nothing in any log names a record of his or holds his words.
    for (const audience of [s.everyone().audienceIds[0] ?? "", s.bob.privateAudienceId]) {
      const scope = { orgId: s.bob.orgId, audienceIds: [audience] };
      const log = await s.ports.store.review.events(scope, audience, 0, 10_000);
      expect(JSON.stringify(log)).not.toContain("BOBMARK");
      expect(log.map((event) => event.subject)).not.toContain(bobFact.id);
      expect(log.map((event) => event.subject)).not.toContain(bobTask);
    }
    expect(AFTER_DELETION.length).toBeGreaterThan(0);
  });

  test("totals of model use are kept seven days and no longer", async () => {
    await w.plain("search_facts", { query: "anything" });
    const [session] = await w.store.sessions.recent(w.owner.orgId, w.owner.principalId, 1);
    if (session === undefined) throw new Error("a call made no session");
    const day = 24 * 3_600_000;
    const first = w.clock.now();
    await w.store.sessions.spent(w.owner.orgId, session.id, { input: 100, output: 0 }, first);
    w.clock.advance(8 * day);
    await w.store.sessions.spent(w.owner.orgId, session.id, { input: 1, output: 0 }, w.clock.now());
    expect(await w.store.sessions.spentSince(new Date(first.getTime() - 1))).toBe(1);
  });
});

describeUseCases("a person's data after they left a group", (w) => {
  const g = groupsWorld(w);

  /** Bob shares a project with `design` and publishes a fact and a task there; Ann then takes him out of `design`. */
  async function leftTheGroup(n: number) {
    const project = P(n + 40);
    const bob = await g.again(g.bob);
    await g.choose(bob, project, "design");
    const calls = g.calls(bob, project);
    const fact = await calls("publish_fact", {
      claim: "BOBGRP ledger table fact",
      citations: "src/ledger.ts:12",
    });
    const task = await calls("publish_task", { title: "BOBGRPTASK" });
    const ann = await g.again(g.ann);
    await g.choose(ann, project, "design");
    const citing = await g.calls(ann, project)("publish_fact", {
      claim: "ANNGRP rests on Bob's ledger fact",
      citations: [{ kind: "fact", fact: fact.id }, "src/ledger.ts:12"],
    });
    await removeFromGroup(g.ports, ann, "design", g.bob.principalId);
    return {
      citing: citing.id,
      project,
      bob: await g.again(g.bob),
      fact,
      task: task.task.id,
    };
  }

  test("what they wrote there is in their download and in what the deletion shows, and is deleted with the account", async () => {
    const { project, bob, fact, task, citing } = await leftTheGroup(1);
    const shown = await accountContents(g.ports, bob);
    expect(shown).toMatchObject({ facts: 1, tasks: 1 });
    expect(shown.groups).toEqual([{ name: "design", other_members: 1, facts: 1, tasks: 1 }]);
    const mine = await exportMine(g.ports, bob);
    expect(mine.facts.map((one) => one.id)).toEqual([fact.id]);
    expect(mine.facts[0]).toMatchObject({ audience: "shared", group: "design" });
    expect(mine.tasks.map((one) => one.id)).toEqual([task]);
    expect(renderMine(mine)).toContain("BOBGRP ledger table fact");
    expect(await g.claimsOf(await g.again(g.ann), project)).toContain("BOBGRP ledger table fact");

    const gone = await deleteAccount(g.ports, bob, { name: bob.displayName });
    expect(gone).toMatchObject({ facts: 1, tasks: 1 });
    expect(await g.claimsOf(await g.again(g.ann), project)).toEqual([
      "ANNGRP rests on Bob's ledger fact",
    ]);
    const flags = await g.ports.store.review.openFlags(scopeOf(await g.again(g.ann)), [citing]);
    expect(flags.map((flag) => flag.kind)).toEqual(["source_changed"]);
    const ann = await g.again(g.ann);
    expect(await g.ports.store.tasks.get(scopeOf(ann), task)).toBeNull();
    expect(await g.ports.store.facts.get(scopeOf(ann), fact.id)).toBeNull();
  });

  test("a record that is still there when the erase runs goes with it, in the same transaction", async () => {
    const cy = await g.again(g.cy);
    const calls = g.calls(cy, P(60));
    const fact = await calls("publish_fact", {
      claim: "CYMARK late write",
      citations: "src/a.ts:1",
    });
    const task = await calls("publish_task", { title: "CYMARK late task" });
    const own = { orgId: cy.orgId, audienceIds: [cy.privateAudienceId] };
    expect(await g.ports.store.facts.get(own, fact.id)).not.toBeNull();
    const erased = await g.ports.store.directory.eraseAccount(cy.orgId, cy.principalId, new Date());
    expect(erased).toMatchObject({ facts: 1, tasks: 1 });
    expect(await g.ports.store.facts.get(own, fact.id)).toBeNull();
    expect(await g.ports.store.tasks.get(own, task.task.id)).toBeNull();
    expect(await g.ports.store.review.history(own, fact.id, 10)).toEqual([]);
  });
});
