import {
  newSession,
  scopeOf,
  type Caller,
  type ClaimedJob,
  type Session,
  type Store,
  type Turn,
} from "@uketsugi/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FakeClock, FakeIdGen } from "../fakes.ts";
import { content, event, openWithPeople, PROJECT, targetOf, type StoreHarness } from "./support.ts";

const LOCK_MS = 60_000;
const MINUTE = 60_000;

/**
 * What every Store adapter must do for the model step: a session's turns, the one job that is
 * about a session, what a reading leaves on its session, and which facts a session published.
 */
export function describeModelStepConformance(name: string, harness: StoreHarness): void {
  describe(`${name}: Store conformance for the model step`, () => {
    const clock = new FakeClock();
    const ids = new FakeIdGen(13);
    let store: Store;
    let alice: Caller;
    let bob: Caller;

    const later = (ms: number): Date => new Date(clock.now().getTime() + ms);

    /** A session of a person's in a project, opened now. */
    async function open(caller: Caller, project = PROJECT): Promise<Session> {
      await store.projects.ensure(caller.orgId, { kind: "repository", key: project });
      const who = { orgId: caller.orgId, principalId: caller.principalId };
      const key = { ...who, clientName: "claude-code", conversationId: ids.uuid(), project };
      const session = newSession(key, ids.uuid(), "2.1.325", clock.now());
      await store.sessions.open(session);
      return session;
    }

    function turn(answer: string): Turn {
      return { id: ids.uuid(), request: "What does it do?", answer, at: clock.now() };
    }

    /** Claims what is due now and returns the job about one session, if it was due. */
    async function claimIfDue(session: Session): Promise<ClaimedJob | undefined> {
      const claimed = await store.jobs.claim(clock.now(), LOCK_MS, 50);
      return claimed.find((job) => job.subject === session.id);
    }

    async function claimOf(session: Session): Promise<ClaimedJob> {
      const mine = await claimIfDue(session);
      if (mine === undefined) throw new Error("the session's reading was not due");
      return mine;
    }

    const stored = async (session: Session): Promise<Session | undefined> =>
      (await store.sessions.byIds(session.orgId, [session.id]))[0];

    beforeAll(async () => {
      ({ store, alice, bob } = await openWithPeople(harness, ids));
    });
    afterAll(() => store.close());

    test("a session's turns are kept in order until a reading is done with them", async () => {
      const session = await open(alice);
      const [first, second, third] = [turn("one"), turn("two"), turn("three")];
      for (const each of [first, second, third]) {
        await store.sessions.addTurn(alice.orgId, session.id, each);
        clock.advance(1000);
      }
      expect(await store.sessions.turns(alice.orgId, session.id)).toEqual([first, second, third]);
      expect(await store.sessions.turns(bob.orgId, session.id)).toEqual([]);
      const at = clock.now();
      await store.sessions.digested(alice.orgId, session.id, { at, turns: [first.id, second.id] });
      expect(await store.sessions.turns(alice.orgId, session.id)).toEqual([third]);
      expect(await stored(session)).toEqual({ ...session, digestedAt: at });
      await store.sessions.dropTurns(alice.orgId, session.id);
      expect(await store.sessions.turns(alice.orgId, session.id)).toEqual([]);
    });

    test("an answer completes the turn its request began, and is a turn of its own where none waits", async () => {
      const session = await open(alice);
      const asked = { id: ids.uuid(), request: "Why twice?", answer: null, at: clock.now() };
      await store.sessions.addTurn(alice.orgId, session.id, asked);
      clock.advance(5000);
      const first = { id: ids.uuid(), answer: "Because of the retry.", at: clock.now() };
      await store.sessions.answerTurn(alice.orgId, session.id, first);
      clock.advance(5000);
      const second = { id: ids.uuid(), answer: "And the cap is 30 s.", at: clock.now() };
      await store.sessions.answerTurn(alice.orgId, session.id, second);
      expect(await store.sessions.turns(alice.orgId, session.id)).toEqual([
        { ...asked, answer: first.answer, at: first.at },
        { ...second, request: null },
      ]);
    });

    test("a session has one job, about no audience, claimed when it is due and not before", async () => {
      const session = await open(alice);
      const due = later(10 * MINUTE);
      await store.jobs.armDigest(alice.orgId, session.id, due);
      expect(await claimIfDue(session)).toBeUndefined();
      clock.advance(10 * MINUTE);
      expect(await claimOf(session)).toEqual({
        orgId: alice.orgId,
        id: session.id,
        kind: "digest",
        subject: session.id,
        audienceId: null,
        runAfter: due,
        attempts: 1,
      });
      expect(await claimIfDue(session)).toBeUndefined();
      // A claim nobody ends is due again when its lock runs out: a worker that died loses nothing.
      clock.advance(LOCK_MS + 1);
      const again = await claimOf(session);
      expect(again.attempts).toBe(2);
      await store.jobs.complete(again);
      clock.advance(LOCK_MS + 1);
      expect(await claimIfDue(session)).toBeUndefined();
    });

    test("arming a session again moves its job, later or sooner, and starts its attempts from none", async () => {
      const session = await open(alice);
      await store.jobs.armDigest(alice.orgId, session.id, later(10 * MINUTE));
      await store.jobs.armDigest(alice.orgId, session.id, later(20 * MINUTE));
      clock.advance(10 * MINUTE);
      expect(await claimIfDue(session)).toBeUndefined();
      await store.jobs.armDigest(alice.orgId, session.id, clock.now());
      const failed = await claimOf(session);
      await store.jobs.fail(failed, null);
      // A job that was given up is one again once its session leaves something new.
      await store.jobs.armDigest(alice.orgId, session.id, clock.now());
      const fresh = await claimOf(session);
      expect(fresh.attempts).toBe(1);
      await store.jobs.complete(fresh);
    });

    test("a job armed again while it ran stays for its new time; one that was not is retired", async () => {
      const session = await open(alice);
      await store.jobs.armDigest(alice.orgId, session.id, clock.now());
      const running = await claimOf(session);
      const next = later(10 * MINUTE);
      await store.jobs.armDigest(alice.orgId, session.id, next);
      await store.jobs.complete(running);
      expect(await claimIfDue(session)).toBeUndefined();
      clock.advance(10 * MINUTE);
      const second = await claimOf(session);
      expect(second).toMatchObject({ runAfter: next, attempts: 1 });
      await store.jobs.complete(second);
      clock.advance(LOCK_MS + 1);
      expect(await claimIfDue(session)).toBeUndefined();
    });

    test("a waiting job is brought forward, and none is made where none waits", async () => {
      const [waiting, idle] = [await open(alice), await open(alice)];
      await store.jobs.armDigest(alice.orgId, waiting.id, later(10 * MINUTE));
      for (const session of [waiting, idle]) {
        await store.jobs.hastenDigest(alice.orgId, session.id, clock.now());
      }
      await store.jobs.hastenDigest(bob.orgId, waiting.id, clock.now());
      await store.jobs.complete(await claimOf(waiting));
      expect(await claimIfDue(idle)).toBeUndefined();
    });

    test("what a session's readings cost is added up on it, and a session opens unread at no cost", async () => {
      const session = await open(alice);
      expect(await stored(session)).toMatchObject({
        digestedAt: null,
        modelTokens: { input: 0, output: 0 },
      });
      await store.sessions.spent(alice.orgId, session.id, { input: 1200, output: 90 }, new Date());
      await store.sessions.spent(alice.orgId, session.id, { input: 300, output: 90 }, new Date());
      await store.sessions.spent(bob.orgId, session.id, { input: 7, output: 7 }, new Date());
      expect(await stored(session)).toMatchObject({
        digestedAt: null,
        modelTokens: { input: 1500, output: 180 },
      });
    });

    test("a failed reading is kept on the session, replaced by the next failure, and cleared by a reading that finishes", async () => {
      const session = await open(alice);
      const first = { at: new Date("2026-11-14T10:00:00Z"), reason: "status 402: no credit" };
      const second = { at: new Date("2026-11-14T11:00:00Z"), reason: "status 404: retired" };
      await store.sessions.digestFailed(alice.orgId, session.id, first);
      // Another org's call does not reach her session.
      await store.sessions.digestFailed(bob.orgId, session.id, { ...second, reason: "not hers" });
      expect(await stored(session)).toMatchObject({ digestFailure: first });
      await store.sessions.digestFailed(alice.orgId, session.id, second);
      expect(await stored(session)).toMatchObject({ digestFailure: second });
      await store.sessions.digested(alice.orgId, session.id, { at: clock.now(), turns: [] });
      expect(await stored(session)).toMatchObject({ digestFailure: null });
    });

    test("the facts published in a session are found by the session, by a reader who may see their log", async () => {
      const session = await open(alice);
      const other = await open(alice);
      const published: string[] = [];
      for (const [n, from] of [session, other, session].entries()) {
        const id = ids.uuid();
        const fact = { id, project: PROJECT, author: alice.principalId, vector: null };
        await store.unit(targetOf(alice, clock.now()), async (unit) => {
          await unit.facts.insert({
            ...fact,
            content: content(`Published in a session, number ${n}`),
            ...(n === 2 ? { digestSession: from.id } : {}),
          });
          await unit.append({ ...event(id, alice.principalId), session: from.id });
          // A later entry about the fact is not its publishing.
          await unit.append({ ...event(id, alice.principalId, "FactConfirmed"), session: from.id });
        });
        if (from === session) published.push(id);
        clock.advance(1000);
      }
      expect(await store.review.publishedIn(scopeOf(alice), session.id)).toEqual(published);
      expect(await store.review.publishedIn(scopeOf(bob), session.id)).toEqual([]);
      expect(await store.review.publishedIn(scopeOf(alice), "not-an-id")).toEqual([]);
      // A fact says which session a model wrote it from, and one an agent published says none.
      const facts = await store.facts.getMany(scopeOf(alice), published);
      const from = new Map(facts.map((fact) => [fact.id, fact.digestSession]));
      expect(published.map((id) => from.get(id))).toEqual([null, session.id]);
    });

    test("the newest choice of facts for a person's next brief in a project is the one read", async () => {
      const project = "github.com/acme/picks";
      const who = [alice.orgId, alice.principalId, project] as const;
      expect(await store.sessions.picks(...who)).toEqual([]);
      const chosen = [ids.uuid(), ids.uuid()];
      for (const picks of [[ids.uuid()], chosen]) {
        clock.advance(MINUTE);
        const session = await open(alice, project);
        await store.sessions.digested(alice.orgId, session.id, {
          at: clock.now(),
          turns: [],
          picks,
        });
      }
      // A later reading that chose nothing leaves the choice before it standing.
      clock.advance(MINUTE);
      const last = await open(alice, project);
      await store.sessions.digested(alice.orgId, last.id, { at: clock.now(), turns: [] });
      expect(await store.sessions.picks(...who)).toEqual(chosen);
      expect(await store.sessions.picks(alice.orgId, alice.principalId, PROJECT)).toEqual([]);
      expect(await store.sessions.picks(bob.orgId, bob.principalId, project)).toEqual([]);
    });
  });
}
