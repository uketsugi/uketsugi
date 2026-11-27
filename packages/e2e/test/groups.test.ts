/**
 * Groups: people of one organization share a project with the people they name and not with the
 * rest. The organization is Ann's, who made it and so is its administrator; Bob and Cy were added
 * after her. Everyone is in `everyone`; `design` is Ann and Bob.
 */
import {
  acceptInvitation,
  addToGroup,
  createTokenIdentity,
  invitePerson,
  listFacts,
  listGroups,
  listProjects,
  listTasks,
  joinProjects,
  makeGroup,
  makeInvitation,
  removeFromGroup,
  removePerson,
  scopeOf,
} from "@uketsugi/core";
import { expect, test } from "vitest";
import { CHECKABLE } from "./sharing-world.ts";
import { describeUseCases } from "./use-case-world.ts";
import { CLAIM, groupsWorld, P } from "./groups-world.ts";

const idOf = (people: { id: string; name: string }[], name: string): string =>
  people.find((person) => person.name === name)?.id ?? "";

describeUseCases("groups", (w) => {
  const s = groupsWorld(w);

  test("two people of one organization share a project, and a third of it sees no fact, task, search result or brief line of it", async () => {
    const project = P(1);
    const published = await s.calls(s.ann, project)("publish_fact", {
      claim: CLAIM,
      citations: CHECKABLE,
    });
    await s.calls(s.ann, project)("publish_task", { title: "Rename nothing in the ledger" });
    const chosen = await s.choose(s.ann, project, "design");
    expect(chosen).toMatchObject({ treatment: "shared", group: "design", moved: { facts: 1 } });

    expect(await s.claimsOf(s.bob, project)).toEqual([CLAIM]);
    expect(
      (await listFacts(s.ports, await s.again(s.bob), { project, limit: 100 })).facts,
    ).toHaveLength(1);
    expect(
      (await listTasks(s.ports, await s.again(s.bob), { project, limit: 100 })).tasks,
    ).toHaveLength(1);

    // Cy is in `everyone` and not in `design`: nothing of it reaches any read, by id or in a list.
    const seen = await s.calls(s.cy, project)("search_facts", { query: "ledger table" });
    expect(JSON.stringify(seen)).not.toContain(CLAIM);
    expect(seen.facts).toEqual([]);
    expect(
      await s.ports.store.facts.get(scopeOf(await s.again(s.ann)), published.id),
    ).not.toBeNull();
    const cyNow = await s.again(s.cy);
    expect(
      await s.ports.store.facts.get(
        { orgId: cyNow.orgId, audienceIds: cyNow.visibleAudienceIds },
        published.id,
      ),
    ).toBeNull();
    expect((await listFacts(s.ports, cyNow, { project, limit: 100 })).facts).toEqual([]);
    expect((await listTasks(s.ports, cyNow, { project, limit: 100 })).tasks).toEqual([]);
    const brief = await s.calls(s.cy, project)("search_tasks", {});
    expect(JSON.stringify(brief)).not.toContain("Rename nothing");
    // What the agent is told of a fact it publishes names the group, and `everyone`'s words are the old ones.
    expect(published.text).not.toContain("design");
    const second = await s.calls(s.ann, project)("publish_fact", {
      claim: "A second fact about the ledger rows",
      citations: CHECKABLE,
    });
    expect(second.text).toContain("shared · members of the group design see it");
    expect(second.group).toBe("design");
    const bobs = await s.calls(s.bob, P(2))("publish_fact", {
      claim: "Bob's claim",
      citations: CHECKABLE,
    });
    await s.choose(s.bob, P(2));
    const shared = await s.calls(s.bob, P(2))("update_fact", { id: bobs.id, citations: CHECKABLE });
    expect(shared.text).toContain("shared · everyone on this server sees it");
    expect(shared.group).toBeUndefined();
  });

  test("a person taken out of a group sees none of its projects from then on, their choice no longer holds, and what they published there stays under their name", async () => {
    const project = P(3);
    await s.choose(s.ann, project, "design");
    await s.choose(s.bob, project, "design");
    await s.calls(s.ann, project)("publish_fact", { claim: CLAIM, citations: CHECKABLE });
    const his = await s.calls(s.bob, project)("publish_fact", {
      claim: "Bob found the ledger index missing",
      citations: CHECKABLE,
    });
    expect(await s.claimsOf(s.bob, project)).toHaveLength(2);

    await removeFromGroup(s.ports, await s.again(s.ann), "design", s.bob.principalId);
    const left = await s.again(s.bob);
    expect(left.groups.map((group) => group.name)).toEqual(["everyone"]);
    expect(await s.claimsOf(left, project)).toEqual([]);
    expect(
      await s.ports.store.facts.get(
        { orgId: left.orgId, audienceIds: left.visibleAudienceIds },
        his.id,
      ),
    ).toBeNull();
    const listed = await listProjects(s.ports, left);
    expect(listed.projects.find((one) => one.key === project)).toMatchObject({
      treatment: "private",
    });
    // What Bob published stays where it was, for the people still in the group, under his name.
    const stayed = await listFacts(s.ports, await s.again(s.ann), { project, limit: 100 });
    expect(stayed.facts.map((fact) => fact.author)).toContain("bob");
    // He is back, and sees it again as it stands: the group's records were never his to take away.
    await addToGroup(s.ports, await s.again(s.ann), "design", { person: s.bob.principalId });
    expect(await s.claimsOf(await s.again(s.bob), project)).toHaveLength(2);
    // His old choice does not come back with his membership: he shares again, or not, by his own act.
    const back = await listProjects(s.ports, await s.again(s.bob));
    expect(back.projects.find((one) => one.key === project)).toMatchObject({
      treatment: "private",
    });
    s.bob = await s.again(s.bob);
  });

  test("removing a person from the organization takes them out of every group, and the hosted identity cannot sign them in again", async () => {
    const dee = await invitePerson(s.ports, w.owner, { name: "dee", operator_name: "ann" });
    const deeCaller = await createTokenIdentity(s.ports).authenticate(dee.issued[0]?.secret);
    await addToGroup(s.ports, await s.again(s.ann), "design", { person: deeCaller.principalId });
    expect((await s.again(deeCaller)).groups.map((group) => group.name).sort()).toEqual([
      "design",
      "everyone",
    ]);
    await removeFromGroup(s.ports, await s.again(s.ann), "everyone", deeCaller.principalId);
    expect(
      await s.ports.store.directory.callerOf(deeCaller.orgId, deeCaller.principalId),
    ).toBeNull();
    const groups = (await listGroups(s.ports, await s.again(s.ann))).groups;
    for (const group of groups) {
      expect(group.members.map((member) => member.name)).not.toContain("dee");
    }
    expect(await s.ports.store.directory.knownSubject(`local:${deeCaller.principalId}`)).toEqual({
      orgId: s.ann.orgId,
      removed: true,
    });
  });

  test("only the person who made the organization makes groups and says who is in them, a name is one group's, and the administrator stays", async () => {
    const [mine, theirs] = [await s.again(s.ann), await s.again(s.bob)];
    await expect(makeGroup(s.ports, theirs, { name: "bobs" })).rejects.toThrow(
      /Only the person who made/,
    );
    await expect(makeGroup(s.ports, mine, { name: "Design" })).rejects.toThrow(
      /cannot name a new group/,
    );
    await expect(makeGroup(s.ports, mine, { name: "everyone" })).rejects.toThrow(
      /every organization's own/,
    );
    await expect(
      addToGroup(s.ports, theirs, "design", { person: s.cy.principalId }),
    ).rejects.toThrow(/Only the person who made/);
    await expect(removeFromGroup(s.ports, mine, "everyone", mine.principalId)).rejects.toThrow(
      /cannot be taken out/,
    );
    await expect(
      addToGroup(s.ports, mine, "nonesuch", { person: s.cy.principalId }),
    ).rejects.toThrow(/no group called/);
    const seenByCy = await listGroups(s.ports, await s.again(s.cy));
    expect(seenByCy).toMatchObject({ administrator: false, people: [] });
    expect(seenByCy.groups.map((group) => group.name)).toEqual(["everyone"]);
    expect(idOf((await listGroups(s.ports, mine)).people, "cy")).toBe(s.cy.principalId);
  });

  test("a project is shared with one group at a time, with a group the person is in, and what is written on another group's records is refused", async () => {
    const project = P(4);
    await makeGroup(s.ports, await s.again(s.ann), { name: "ops" });
    await addToGroup(s.ports, await s.again(s.ann), "ops", { person: s.bob.principalId });
    await addToGroup(s.ports, await s.again(s.ann), "ops", { person: s.ann.principalId });
    await s.calls(s.ann, project)("publish_fact", { claim: CLAIM, citations: CHECKABLE });
    await s.choose(s.ann, project, "design");
    await expect(s.choose(s.ann, project, "ops")).rejects.toThrow(/shared with design/);
    await expect(s.choose(s.cy, project, "design")).rejects.toThrow(
      /not in a group called "design"/,
    );
    // Bob is in both groups and shares this project with `ops`: Ann's record is in `design`, and his
    // write on it is refused, with the group named; Cy, who is not in `design`, cannot reach it at all.
    await s.choose(s.bob, project, "ops");
    const record = (await s.claimsOf(await s.again(s.bob), project)).length;
    expect(record).toBe(1);
    const found = await listFacts(s.ports, await s.again(s.bob), { project, limit: 100 });
    const id = found.facts[0]?.id ?? "";
    await expect(
      s.calls(s.bob, project)("update_fact", { id, confirm: { checked: "read it" } }),
    ).rejects.toThrow(/shared with the group design/);
    await expect(
      s.calls(s.cy, project)("update_fact", { id, confirm: { checked: "read it" } }),
    ).rejects.toThrow(/not found|No fact/i);
  });

  test("a join is refused while a group of the person's holds records of the first project, and goes through otherwise", async () => {
    const [from, into, plain] = [P(5), P(6), P(7)];
    await s.calls(s.ann, from)("publish_fact", { claim: CLAIM, citations: CHECKABLE });
    await s.choose(s.ann, from, "design");
    await s.calls(s.bob, from)("publish_fact", { claim: "Bob's note", citations: CHECKABLE });
    await expect(joinProjects(s.ports, await s.again(s.bob), { from, into })).rejects.toThrow(
      /shared record/,
    );
    await s.calls(s.cy, plain)("publish_fact", { claim: "Cy's own", citations: CHECKABLE });
    const joined = await joinProjects(s.ports, await s.again(s.cy), { from: plain, into });
    expect(joined).toMatchObject({ from: plain, into, facts: 1 });
  });

  test("an invitation is used once, expires after seven days, and is not for a subject that has an account", async () => {
    const admin = await s.again(s.ann);
    const first = await makeInvitation(s.ports, admin);
    await expect(makeInvitation(s.ports, await s.again(s.bob))).rejects.toThrow(
      /Only the person who made/,
    );
    const joined = await acceptInvitation(s.ports, first.secret, {
      displayName: "eve",
      subject: "idp#eve",
    });
    expect(joined.orgId).toBe(admin.orgId);
    expect(joined.groups.map((group) => group.name)).toEqual(["everyone"]);
    await expect(
      acceptInvitation(s.ports, first.secret, { displayName: "fay", subject: "idp#fay" }),
    ).rejects.toThrow(/used already/);
    const second = await makeInvitation(s.ports, admin);
    await expect(
      acceptInvitation(s.ports, second.secret, { displayName: "eve", subject: "idp#eve" }),
    ).rejects.toThrow(/already have an account/);
    await expect(
      acceptInvitation(s.ports, "ukv_nothing", { displayName: "x", subject: "idp#x" }),
    ).rejects.toThrow(/not an invitation/);
    w.clock.advance(7 * 24 * 60 * 60 * 1000 + 1);
    await expect(
      acceptInvitation(s.ports, second.secret, { displayName: "gus", subject: "idp#gus" }),
    ).rejects.toThrow(/expired/);
    const third = await makeInvitation(s.ports, admin);
    await removePerson(s.ports, admin, joined.principalId);
    expect(
      await acceptInvitation(s.ports, third.secret, { displayName: "hal", subject: "idp#hal" }),
    ).toMatchObject({
      orgId: admin.orgId,
    });
  });
});
