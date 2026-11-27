/**
 * Groups and citations: a fact that cites a fact of another project, in another group of the same
 * person, is placed by its own project's group and follows what it cites when that is shared or
 * taken back, whichever group has the smaller id. The people are those of `groups-world.ts`.
 */
import {
  addToGroup,
  chooseTreatment,
  factDetail,
  listFacts,
  makeGroup,
  scopeOf,
  type Caller,
} from "@uketsugi/core";
import { expect, test } from "vitest";
import { CHECKABLE, TESTIMONY } from "./sharing-world.ts";
import { describeUseCases } from "./use-case-world.ts";
import { CLAIM, groupsWorld, P } from "./groups-world.ts";

describeUseCases("groups and citations", (w) => {
  const s = groupsWorld(w);

  test("a fact cites a fact held in another group of the same person, whichever group has the smaller id, on publish and on a correction", async () => {
    await makeGroup(s.ports, await s.again(s.ann), { name: "lo" });
    await makeGroup(s.ports, await s.again(s.ann), { name: "hi" });
    for (const group of ["lo", "hi"])
      await addToGroup(s.ports, await s.again(s.ann), group, { person: s.ann.principalId });
    s.ann = await s.again(s.ann);
    const [lowId, highId] = s.ann.groups
      .filter((group) => group.name === "lo" || group.name === "hi")
      .map((group) => group.id);
    expect(String(lowId) < String(highId)).toBe(true);
    // The cited fact is in the group of the smaller id and the citing one in the larger, and the reverse.
    for (const [cited, citing, n] of [
      ["lo", "hi", 10],
      ["hi", "lo", 12],
    ] as const) {
      const [from, to] = [P(n), P(n + 1)];
      await s.choose(s.ann, from, cited);
      await s.choose(s.ann, to, citing);
      const source = await s.calls(s.ann, from)("publish_fact", {
        claim: CLAIM,
        citations: CHECKABLE,
      });
      const built = await s.calls(s.ann, to)("publish_fact", {
        claim: `A fact built on the ledger rule (${n})`,
        citations: [{ kind: "fact", fact: source.id }],
      });
      expect(built, `${cited} cited from ${citing}`).toMatchObject({ audience: "shared" });
      const plain = await s.calls(s.ann, to)("publish_fact", {
        claim: `A fact that is later given a source (${n})`,
        citations: CHECKABLE,
      });
      const corrected = await s.calls(s.ann, to)("update_fact", {
        id: plain.id,
        citations: [{ kind: "fact", fact: source.id }, CHECKABLE],
      });
      expect(corrected.audience, `${cited} cited from ${citing}, corrected`).toBe("shared");
    }
  });
  test("a reader of one group who sees a fact citing a fact of another group is shown its id and nothing of its record", async () => {
    await makeGroup(s.ports, await s.again(s.ann), { name: "left" });
    await makeGroup(s.ports, await s.again(s.ann), { name: "right" });
    for (const group of ["left", "right"])
      await addToGroup(s.ports, await s.again(s.ann), group, { person: s.ann.principalId });
    await addToGroup(s.ports, await s.again(s.ann), "left", { person: s.cy.principalId });
    s.ann = await s.again(s.ann);
    const [from, to] = [P(20), P(21)];
    await s.choose(s.ann, from, "right");
    await s.choose(s.ann, to, "left");
    const secret = "The ledger archive key rotates on the first of March";
    const source = await s.calls(s.ann, from)("publish_fact", {
      claim: secret,
      detail: "Only the right group may read this detail",
      citations: CHECKABLE,
    });
    const built = await s.calls(s.ann, to)("publish_fact", {
      claim: "Archive rotation is scheduled",
      citations: [{ kind: "fact", fact: source.id }],
    });
    expect(built).toMatchObject({ audience: "shared", group: "left" });
    const reader = await s.again(s.cy);
    const found = await s.calls(reader, to)("search_facts", { query: "archive rotation" });
    expect(found.facts.map((fact) => fact.claim)).toEqual(["Archive rotation is scheduled"]);
    const page = await listFacts(s.ports, reader, { project: to, limit: 100 });
    const detail = await factDetail(s.ports, reader, built.id);
    for (const shown of [found, page, detail]) {
      const text = JSON.stringify(shown);
      expect(text).not.toContain(secret);
      expect(text).not.toContain("Only the right group");
      expect(text).toContain(source.id);
    }
    expect(JSON.stringify(found)).not.toContain("ledger archive");
  });
  test("sharing a project moves only that project's facts into its group, and the facts of another project that cite them go to their own project's group, whichever group has the smaller id", async () => {
    await makeGroup(s.ports, await s.again(s.ann), { name: "s1" });
    await makeGroup(s.ports, await s.again(s.ann), { name: "s2" });
    for (const person of [s.ann, s.cy])
      await addToGroup(s.ports, await s.again(s.ann), "s1", { person: person.principalId });
    for (const person of [s.ann, s.bob])
      await addToGroup(s.ports, await s.again(s.ann), "s2", { person: person.principalId });
    s.ann = await s.again(s.ann);
    const idOfGroup = (name: string) => s.ann.groups.find((group) => group.name === name)?.id ?? "";
    // Order one: the project shared now is in the smaller group, the citing project's group is the larger; then the reverse.
    for (const [now, other, n] of [
      ["s1", "s2", 30],
      ["s2", "s1", 32],
    ] as const) {
      const [a, b] = [P(n), P(n + 1)];
      await s.choose(s.ann, b, other);
      const source = await s.calls(s.ann, a)("publish_fact", {
        claim: CLAIM,
        citations: CHECKABLE,
      });
      const built = await s.calls(s.ann, b)("publish_fact", {
        claim: `Built on the ledger rule (${n})`,
        citations: [{ kind: "fact", fact: source.id }],
      });
      expect(built.audience).toBe("private");
      const shared = await s.choose(s.ann, a, now);
      expect(shared.moved.facts, `${now} then ${other}`).toBe(2);
      const where = async (id: string) =>
        (await s.ports.store.facts.get(scopeOf(await s.again(s.ann)), id))?.audienceId;
      expect(await where(source.id)).toBe(idOfGroup(now));
      expect(await where(built.id)).toBe(idOfGroup(other));
      // Only the people of a project's group read its facts.
      const member = { s1: s.cy, s2: s.bob };
      expect(await s.claimsOf(await s.again(member[now]), a)).toEqual([CLAIM]);
      expect(await s.claimsOf(await s.again(member[now]), b)).toEqual([]);
      expect(
        (await listFacts(s.ports, await s.again(member[now]), { project: b, limit: 100 })).facts,
      ).toEqual([]);
      expect(
        (await listFacts(s.ports, await s.again(member[other]), { project: b, limit: 100 })).facts,
      ).toHaveLength(1);
      expect(
        (await listFacts(s.ports, await s.again(member[other]), { project: a, limit: 100 })).facts,
      ).toEqual([]);
    }
  });
  test("taking a project back to private brings home the facts of other projects that cite its facts, wherever their group is, and sharing it again puts every fact back where it was", async () => {
    await makeGroup(s.ports, await s.again(s.ann), { name: "t1" });
    await makeGroup(s.ports, await s.again(s.ann), { name: "t2" });
    for (const person of [s.ann, s.cy])
      await addToGroup(s.ports, await s.again(s.ann), "t1", { person: person.principalId });
    for (const person of [s.ann, s.bob])
      await addToGroup(s.ports, await s.again(s.ann), "t2", { person: person.principalId });
    s.ann = await s.again(s.ann);
    const idOfGroup = (name: string) => s.ann.groups.find((group) => group.name === name)?.id ?? "";
    const where = async (id: string) =>
      (await s.ports.store.facts.get(scopeOf(await s.again(s.ann)), id))?.audienceId;
    const member = { t1: s.cy, t2: s.bob };
    const read = async (who: Caller, project: string) =>
      (await listFacts(s.ports, await s.again(who), { project, limit: 100 })).facts.length;
    for (const [now, other, n] of [
      ["t1", "t2", 40],
      ["t2", "t1", 42],
    ] as const) {
      const [a, b] = [P(n), P(n + 1)];
      await s.choose(s.ann, b, other);
      const source = await s.calls(s.ann, a)("publish_fact", {
        claim: CLAIM,
        citations: CHECKABLE,
      });
      const built = await s.calls(s.ann, b)("publish_fact", {
        claim: `Built on the ledger rule (${n})`,
        citations: [{ kind: "fact", fact: source.id }],
      });
      const places = async () => [await where(source.id), await where(built.id)];
      const start = await places();
      expect(start, "both private to begin with").toEqual([
        s.ann.privateAudienceId,
        s.ann.privateAudienceId,
      ]);

      await s.choose(s.ann, a, now);
      const shared = await places();
      expect(shared).toEqual([idOfGroup(now), idOfGroup(other)]);

      // Taking A back brings FA home, and FB with it: it cites a fact its readers can no longer open.
      const back = await chooseTreatment(s.ports, await s.again(s.ann), {
        project: a,
        treatment: "private",
      });
      expect(back.moved.facts, `${now} then ${other}, taken back`).toBe(2);
      expect(await places()).toEqual(start);
      expect(await read(member[other], b)).toBe(0);
      expect(await read(member[now], a)).toBe(0);

      // And sharing it again is the same as the first time: every fact where it was.
      await s.choose(s.ann, a, now);
      expect(await places()).toEqual(shared);
      expect(await read(member[other], b)).toBe(1);
      expect(await read(member[now], b)).toBe(0);
      expect(await read(member[now], a)).toBe(1);
    }
  });
  test("a take-back flags a fact of another person, in another of the groups, that cites what came home", async () => {
    // Bob reads Ann's shared fact in `u1`/`u2` and cites it from a project he shares with the other group.
    for (const name of ["u1", "u2"]) await makeGroup(s.ports, await s.again(s.ann), { name });
    for (const name of ["u1", "u2"])
      for (const person of [s.ann, s.bob])
        await addToGroup(s.ports, await s.again(s.ann), name, { person: person.principalId });
    for (const [ours, his, n] of [
      ["u1", "u2", 50],
      ["u2", "u1", 52],
    ] as const) {
      const [a, b] = [P(n), P(n + 1)];
      await s.choose(s.ann, a, ours);
      await s.choose(s.bob, b, his);
      const source = await s.calls(await s.again(s.ann), a)("publish_fact", {
        claim: CLAIM,
        citations: CHECKABLE,
      });
      const bobs = await s.calls(await s.again(s.bob), b)("publish_fact", {
        claim: `Bob builds on the ledger rule (${n})`,
        citations: [{ kind: "fact", fact: source.id }],
      });
      expect(bobs.audience, `${ours} then ${his}`).toBe("shared");
      const flagsOf = async () =>
        (await s.ports.store.review.openFlags(scopeOf(await s.again(s.bob)), [bobs.id])).map(
          (flag) => flag.kind,
        );
      expect(await flagsOf()).toEqual([]);
      await chooseTreatment(s.ports, await s.again(s.ann), { project: a, treatment: "private" });
      expect(await flagsOf(), `${ours} then ${his}, taken back`).toContain("source_changed");
    }
  });

  test("update_fact on a fact that moves into its group, with a citation across two groups and a third group of the person's besides, succeeds in both id orders", async () => {
    for (const name of ["x1", "x2", "x3"]) await makeGroup(s.ports, await s.again(s.ann), { name });
    for (const name of ["x1", "x2", "x3"])
      await addToGroup(s.ports, await s.again(s.ann), name, { person: s.ann.principalId });
    s.ann = await s.again(s.ann);
    // x1 is smaller than both and holds nothing of this: the move still has to reach it, first.
    for (const [cited, citing, n] of [
      ["x2", "x3", 60],
      ["x3", "x2", 62],
    ] as const) {
      const [from, to] = [P(n), P(n + 1)];
      await s.choose(s.ann, from, cited);
      await s.choose(s.ann, to, citing);
      const source = await s.calls(s.ann, from)("publish_fact", {
        claim: CLAIM,
        citations: CHECKABLE,
      });
      const alone = await s.calls(s.ann, to)("publish_fact", {
        claim: `A fact on a word alone (${n})`,
        citations: [TESTIMONY],
      });
      expect(alone.audience).toBe("private");
      const moved = await s.calls(s.ann, to)("update_fact", {
        id: alone.id,
        citations: [{ kind: "fact", fact: source.id }],
      });
      expect(moved, `${cited} cited from ${citing}`).toMatchObject({
        audience: "shared",
        group: citing,
      });
    }
  });
});
