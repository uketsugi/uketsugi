import { scopeOf, type Caller, type NewFact, type Session, type Store } from "@uketsugi/core";
import { expect, test } from "vitest";
import { fakeUuid } from "../fakes.ts";
import { event, targetOf, UNREAD } from "./support.ts";

/** What the Store suite lends its hosting cases: the store under test, two people and its builders. */
export interface HostingFixture {
  store(): Store;
  /** Two people in different organizations. */
  people(): readonly [Caller, Caller];
  now(): Date;
  fact(caller: Caller, claim: string): NewFact;
}

/**
 * How a Store must behave as a host, whatever engine and driver are behind it: units that arrive
 * together, a failure among them, and values that cross the driver unchanged. The embedded engine
 * has one connection and a server has a pool; these cases are where the two could differ.
 */
export function hostingCases(fixture: HostingFixture): void {
  test("units that arrive together all commit, a failed one aside, and each log has no gap", async () => {
    const store = fixture.store();
    const before = new Map<string, number>();
    for (const caller of fixture.people()) {
      const scope = scopeOf(caller);
      const events = await store.review.events(scope, caller.privateAudienceId, 0, 1000);
      before.set(caller.principalId, events.length);
    }
    const drafts = Array.from({ length: 16 }, (_, n) => {
      const caller = fixture.people()[n % 2 === 0 ? 0 : 1];
      return {
        caller,
        fails: n === 6 || n === 7,
        draft: fixture.fact(caller, `Arrived together, number ${n}`),
      };
    });
    const settled = await Promise.allSettled(
      drafts.map(({ caller, fails, draft }) =>
        store.unit(targetOf(caller, fixture.now()), async (unit) => {
          await unit.facts.insert(draft);
          await unit.append(event(draft.id, caller.principalId));
          if (fails) throw new Error("stop");
        }),
      ),
    );
    expect(settled.map((result) => result.status === "rejected")).toEqual(
      drafts.map(({ fails }) => fails),
    );
    for (const caller of fixture.people()) {
      const scope = scopeOf(caller);
      const mine = drafts.filter((entry) => entry.caller === caller);
      const kept = mine.filter((entry) => !entry.fails).map((entry) => entry.draft.id);
      const stored = await store.facts.getMany(
        scope,
        mine.map((entry) => entry.draft.id),
      );
      expect(stored.map((fact) => fact.id).sort()).toEqual([...kept].sort());
      const events = await store.review.events(scope, caller.privateAudienceId, 0, 1000);
      const added = events.slice(before.get(caller.principalId) ?? 0);
      expect(added.map((entry) => entry.subject).sort()).toEqual([...kept].sort());
      expect(events.map((entry) => entry.seq)).toEqual(events.map((_, index) => index + 1));
    }
  });

  test("inside a unit the store around it refuses a call, and serves again afterwards", async () => {
    const store = fixture.store();
    const [caller] = fixture.people();
    const scope = scopeOf(caller);
    const target = targetOf(caller, fixture.now());
    const around = store.unit(target, () => store.facts.getMany(scope, []));
    await expect(around).rejects.toThrow(/store\.facts\.getMany was called from inside a unit/);
    const nested = store.unit(target, () => store.unit(target, () => Promise.resolve(1)));
    await expect(nested).rejects.toThrow(/store\.unit was called from inside a unit/);
    expect(await store.facts.getMany(scope, [])).toEqual([]);
  });

  test("a time, a hash, a sequence and a citation come back as they went in", async () => {
    const store = fixture.store();
    const [caller] = fixture.people();
    const scope = scopeOf(caller);
    const at = new Date(fixture.now().getTime() + 123);
    const draft = fixture.fact(caller, "Values cross the driver unchanged");
    const target = targetOf(caller, at);
    const seq = await store.unit(target, async (unit) => {
      await unit.facts.insert(draft);
      return unit.append(event(draft.id, caller.principalId));
    });
    const stored = await store.facts.get(scope, draft.id);
    expect(stored?.createdAt).toEqual(at);
    expect(stored?.contentHash).toBe(draft.content.contentHash);
    expect(stored?.citations).toEqual(draft.content.citations);
    const events = await store.review.events(scope, caller.privateAudienceId, seq - 1, 1);
    expect(events.map((entry) => [entry.seq, entry.subject, entry.at])).toEqual([
      [seq, draft.id, at],
    ]);
  });

  test("a unit of another audience changes nothing of a fact it cannot see", async () => {
    const store = fixture.store();
    const [owner] = fixture.people();
    const scope = scopeOf(owner);
    const stranger = await store.directory.ensurePrincipal({
      subject: "test:stranger",
      displayName: "stranger",
      orgId: owner.orgId,
      principalId: fakeUuid(99, 1),
      audienceId: fakeUuid(99, 2),
    });
    const source = fixture.fact(owner, "The source the owner's fact rests on");
    const draft = fixture.fact(owner, "The owner's fact holds xk-77 and cites its source");
    const content = { ...draft.content, idents: ["xk-77"], citedFacts: [source.id] };
    const at = fixture.now();
    const own = targetOf(owner, at);
    await store.unit(own, async (unit) => {
      await unit.facts.insert(source);
      await unit.facts.insert({ ...draft, content });
    });
    const foreign = { orgId: owner.orgId, audienceId: stranger.privateAudienceId, at };
    const other = { ...source.content, claim: "stranger", idents: ["stranger"] };
    const cleared = { citations: [], citedFacts: [], contentHash: source.content.contentHash };
    await expect(
      store.unit(foreign, (unit) => unit.facts.rewrite(draft.id, other, null)),
    ).rejects.toThrow(/is not a fact of the unit's audience/);
    await expect(
      store.unit(foreign, (unit) => unit.facts.setCitations(draft.id, cleared)),
    ).rejects.toThrow(/is not a fact of the unit's audience/);
    const tuning = { vectorCutoff: 0.78, admissionCoverage: 0.6, trigramThreshold: 0.5 };
    const asked = { scope, project: draft.project, query: "anything", embedding: null, ...tuning };
    const byIdent = (ident: string) =>
      store.search.passes({ ...asked, idents: [ident], passLimit: 5 });
    expect(await byIdent("xk-77")).toEqual([{ factId: draft.id, pass: "identifier", rank: 1 }]);
    expect(await byIdent("stranger")).toEqual([]);
    expect(await store.unit(own, (unit) => unit.facts.citing(source.id))).toEqual([draft.id]);
  });

  test("a record wider than its table is stored by the table's own columns", async () => {
    const store = fixture.store();
    const [owner] = fixture.people();
    const at = fixture.now();
    const wider = { added: "by a later version of the record" };
    const project = "github.com/acme/wider";
    await store.projects.ensure(owner.orgId, { kind: "repository", key: project, ...wider });
    const session = {
      orgId: owner.orgId,
      principalId: owner.principalId,
      clientName: "wider",
      conversationId: null,
      project,
      id: fakeUuid(98, 1),
      displayId: "s-wide",
      clientVersion: null,
      firstCallAt: at,
      lastCallAt: at,
      lastSearchAt: null,
      lastPublishAt: null,
      refusedCalls: 0,
      calls: 1,
      briefedAt: null,
      note: null,
      ...UNREAD,
    } satisfies Session;
    await store.sessions.open({ ...session, ...wider });
    expect(await store.sessions.byIds(owner.orgId, [session.id])).toEqual([session]);
    const draft = fixture.fact(owner, "A record wider than its table");
    const job = { id: fakeUuid(98, 2), kind: "consolidate" as const, subject: draft.id };
    const target = targetOf(owner, at);
    await store.unit(target, async (unit) => {
      await unit.facts.insert({ ...draft, ...wider });
      await unit.append({ ...event(draft.id, owner.principalId), ...wider });
      await unit.enqueue({ ...job, runAfter: at, ...wider });
      const check = { factId: draft.id, person: owner.principalId, at, sourceVersion: null };
      await unit.review.confirm({ ...check, checked: null, ...wider });
      const raisedBy = { kind: "person" as const, id: owner.principalId };
      const flag = { id: fakeUuid(98, 3), factId: draft.id, kind: "marked_stale" as const };
      await unit.review.raiseFlag({ ...flag, raisedBy, ...wider });
    });
    const scope = scopeOf(owner);
    expect((await store.facts.get(scope, draft.id))?.id).toBe(draft.id);
    await store.jobs.complete({ orgId: owner.orgId, id: job.id, runAfter: at });
  });
}
