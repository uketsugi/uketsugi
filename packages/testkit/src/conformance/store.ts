import { scopeOf, type Caller, type NewFact, type SearchQuery, type Store } from "@uketsugi/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FakeClock, FakeIdGen } from "../fakes.ts";
import { hostingCases } from "./store-hosting.ts";
import { sessionCases } from "./store-sessions.ts";
import {
  content,
  event,
  hash,
  openWithPeople,
  person,
  PROJECT,
  targetOf,
  UNREAD,
  type StoreHarness,
} from "./support.ts";

function query(caller: Caller, text: string, project = PROJECT): SearchQuery {
  const tuning = { vectorCutoff: 0.78, admissionCoverage: 0.6, trigramThreshold: 0.5 };
  const asked = { scope: scopeOf(caller), project, query: text, idents: [], embedding: null };
  return { ...asked, ...tuning, passLimit: 50 };
}

/** What every Store adapter must do for the use cases: units, repeat safety, scoping, search and jobs. */
export function describeStoreConformance(name: string, harness: StoreHarness): void {
  describe(`${name}: Store conformance`, () => {
    const clock = new FakeClock();
    const ids = new FakeIdGen(7);
    let store: Store;
    let alice: Caller;
    let bob: Caller;

    function fact(caller: Caller, claim: string, detail: string | null = null): NewFact {
      const author = caller.principalId;
      const draft = { id: ids.uuid(), project: PROJECT, author };
      return { ...draft, content: content(claim, detail), vector: null };
    }

    async function publish(
      caller: Caller,
      claim: string,
      detail: string | null = null,
    ): Promise<string> {
      const draft = fact(caller, claim, detail);
      await store.unit(targetOf(caller, clock.now()), async (unit) => {
        await unit.facts.insert(draft);
        await unit.append(event(draft.id, caller.principalId));
        await unit.enqueue({
          id: ids.uuid(),
          kind: "embed",
          subject: draft.id,
          runAfter: clock.now(),
        });
      });
      return draft.id;
    }

    const actorOf = (caller: Caller) => ({ kind: "person" as const, id: caller.principalId });

    beforeAll(async () => {
      ({ store, alice, bob } = await openWithPeople(harness, ids));
    });
    afterAll(() => store.close());

    test("a subject resolves to one caller however often it is ensured", async () => {
      const again = await person(store, ids, "test:alice");
      expect(again).toEqual(alice);
      expect(bob.orgId).not.toBe(alice.orgId);
    });

    test("one unit commits the fact, its event and its job together", async () => {
      const id = await publish(alice, "Invoice webhooks retry five times with backoff");
      const stored = await store.facts.get(scopeOf(alice), id);
      expect(stored).toMatchObject({
        id,
        status: "unconfirmed",
        project: PROJECT,
        embedded: false,
      });
      const events = await store.review.events(scopeOf(alice), alice.privateAudienceId, 0, 10);
      expect(events.map((entry) => [entry.seq, entry.subject])).toEqual([[1, id]]);
      const jobs = await store.jobs.claim(clock.now(), 60_000, 10);
      expect(jobs.map((job) => [job.kind, job.subject, job.attempts])).toEqual([["embed", id, 1]]);
      const [job] = jobs;
      if (job !== undefined) await store.jobs.complete(job);
      expect(await store.jobs.counts()).toMatchObject({ waiting: 0, dead: 0 });
    });

    test("a unit that throws leaves nothing behind, and the next event takes the next sequence", async () => {
      const draft = fact(alice, "The gateway times out after three seconds");
      const target = targetOf(alice, clock.now());
      const failed = store.unit(target, async (unit) => {
        await unit.facts.insert(draft);
        await unit.append(event(draft.id, alice.principalId));
        throw new Error("stop");
      });
      await expect(failed).rejects.toThrow("stop");
      expect(await store.facts.get(scopeOf(alice), draft.id)).toBeNull();
      await publish(alice, "The ledger lock is held for up to four seconds");
      const events = await store.review.events(scopeOf(alice), alice.privateAudienceId, 0, 10);
      expect(events.map((entry) => entry.seq)).toEqual([1, 2]);
    });

    test("a repeated publish finds the author's own claim inside the unit", async () => {
      const claim = "Handlers are idempotent on the event id";
      const id = await publish(alice, claim);
      const target = targetOf(alice, clock.now());
      const found = await store.unit(target, (unit) =>
        unit.facts.findByClaimHash(alice.principalId, PROJECT, content(claim).claimHash),
      );
      expect(found?.id).toBe(id);
    });

    test("a fact outside the reader's organization and audiences reads as absent", async () => {
      const id = await publish(alice, "Refunds are settled nightly by the batch job");
      expect(await store.facts.get(scopeOf(bob), id)).toBeNull();
      expect(await store.facts.getMany(scopeOf(bob), [id])).toEqual([]);
      expect(await store.facts.list(scopeOf(bob), { limit: 10 })).toEqual([]);
      expect(await store.search.passes(query(bob, "refunds settled nightly"))).toEqual([]);
      const wrongAudience = { orgId: alice.orgId, audienceIds: [bob.privateAudienceId] };
      expect(await store.facts.get(wrongAudience, id)).toBeNull();
    });

    test("the keyword pass finds a fact by a stemmed word, in its own project only", async () => {
      const id = await publish(alice, "Sessions expire after thirty minutes of inactivity");
      const hits = await store.search.passes(query(alice, "when does a session expire"));
      expect(hits.filter((row) => row.pass === "keyword").map((row) => row.factId)).toContain(id);
      expect(
        await store.search.passes(query(alice, "session expire", "github.com/acme/other")),
      ).toEqual([]);
      const kept = await store.search.candidates(query(alice, "session expire"), [id]);
      expect(kept[0]?.lexemeCoverage).toBe(1);
      const near = await store.search.trigram(query(alice, "sesions expire after thirty minutes"), [
        id,
      ]);
      expect(near.map((row) => row.factId)).toEqual([id]);
    });

    test("a stored vector is found by cosine, and only while the content it was made for stands", async () => {
      const id = await publish(alice, "Vectors live in the row beside the claim");
      const vector = new Float32Array(384).fill(0.05);
      await store.jobs.embedMissing("model-a", clock.now());
      const made = { model: "model-a", vector };
      expect(await store.facts.setVector(alice.orgId, id, hash("stale"), made)).toBe(false);
      const current = (await store.facts.get(scopeOf(alice), id))?.contentHash ?? "";
      expect(await store.facts.setVector(alice.orgId, id, current, made)).toBe(true);
      const hits = await store.search.passes({
        ...query(alice, "unrelated words"),
        embedding: { model: "model-a", vector },
      });
      expect(hits).toContainEqual({ factId: id, pass: "vector", rank: 1 });
    });

    test("a store whose vectors another model made sets them aside, drops its vectors, and scores none meanwhile", async () => {
      const id = await publish(alice, "Vectors are tied to the model that made them");
      const vector = new Float32Array(384).fill(0.05);
      const current = (await store.facts.get(scopeOf(alice), id))?.contentHash ?? "";
      const asked = (model: string) => ({
        ...query(alice, "unrelated words"),
        embedding: { model, vector },
      });
      const found = async (model: string) =>
        (await store.search.passes(asked(model))).some((row) => row.factId === id);
      await store.jobs.embedMissing("model-a", clock.now());
      await store.facts.setVector(alice.orgId, id, current, { model: "model-a", vector });
      expect(await found("model-a")).toBe(true);

      // A query of another model's vector meets none of the stored ones, even before the store is told.
      expect(await found("model-b")).toBe(false);
      expect((await store.facts.get(scopeOf(alice), id))?.embedded).toBe(true);

      // The same model again changes nothing.
      await store.jobs.embedMissing("model-a", clock.now());
      expect(await found("model-a")).toBe(true);

      // The new model opens the store: every vector goes.
      await store.jobs.embedMissing("model-b", clock.now());
      expect((await store.facts.get(scopeOf(alice), id))?.embedded).toBe(false);
      expect(await found("model-a")).toBe(false);
      expect(await found("model-b")).toBe(false);

      await store.facts.setVector(alice.orgId, id, current, { model: "model-b", vector });
      expect(await found("model-b")).toBe(true);
    });

    test("a vector is stored only under the store's recorded model, by whoever writes it", async () => {
      const vector = new Float32Array(384).fill(0.05);
      const [mine, theirs] = [
        { model: "model-b", vector },
        { model: "model-a", vector },
      ];
      await store.jobs.embedMissing("model-b", clock.now());
      const embedded = async (id: string) =>
        (await store.facts.get(scopeOf(alice), id))?.embedded ?? null;

      // A server still running under the old model embeds a fact, and publishes one with its vector.
      const waiting = await publish(alice, "A fact the old server embeds late");
      const hash0 = (await store.facts.get(scopeOf(alice), waiting))?.contentHash ?? "";
      expect(await store.facts.setVector(alice.orgId, waiting, hash0, theirs)).toBe(false);
      expect(await embedded(waiting)).toBe(false);
      const draft = {
        ...fact(alice, "A fact the old server publishes with its vector"),
        vector: theirs,
      };
      await store.unit(targetOf(alice, clock.now()), (unit) => unit.facts.insert(draft));
      expect(await embedded(draft.id)).toBe(false);
      const corrected = content("A fact the old server corrects", null);
      await store.unit(targetOf(alice, clock.now()), (unit) =>
        unit.facts.rewrite(draft.id, corrected, theirs),
      );
      expect(await embedded(draft.id)).toBe(false);

      // The store's own model is stored as it always was.
      expect(await store.facts.setVector(alice.orgId, waiting, hash0, mine)).toBe(true);
      expect(await embedded(waiting)).toBe(true);
    });

    test("a superseded fact names the fact that replaced it and leaves search", async () => {
      const oldId = await publish(alice, "Exports run hourly from the reporting replica");
      const nextId = await publish(alice, "Exports run every fifteen minutes from the replica");
      const target = targetOf(alice, clock.now());
      await store.unit(target, (unit) => unit.facts.supersede(oldId, nextId));
      const old = await store.facts.get(scopeOf(alice), oldId);
      expect(old).toMatchObject({ status: "superseded", supersededBy: nextId });
      const hits = await store.search.passes(query(alice, "exports replica"));
      expect(hits.map((row) => row.factId)).toEqual([nextId]);
    });

    test("a chain of three ends at one live fact, and undoing a link touches only that link", async () => {
      const scope = scopeOf(alice);
      const [a, b, c] = await Promise.all(
        ["first", "second", "third"].map((n) => publish(alice, `The ${n} wording of one claim`)),
      );
      if (a === undefined || b === undefined || c === undefined) throw new Error("no facts");
      const target = targetOf(alice, clock.now());
      const refused = await store.unit(target, async (unit) => {
        await unit.facts.supersede(a, b);
        await unit.facts.supersede(b, c);
        // No fact supersedes itself, a superseded fact supersedes nothing, and a link is written once.
        const outcomes: string[] = [];
        for (const [id, by] of [
          [c, c],
          [c, a],
          [a, c],
        ] as const) {
          const tried = unit.facts.supersede(id, by);
          outcomes.push(
            await tried.then(
              () => "done",
              (error: unknown) => String(error),
            ),
          );
        }
        return outcomes;
      });
      expect(refused).toEqual(Array(3).fill(expect.stringContaining("was not superseded by")));
      const linked = await store.facts.get(scope, a);
      expect(linked?.supersededBy).toBe(b);
      const heads = new Map([
        [a, c],
        [b, c],
      ]);
      expect(await store.facts.heads(scope, [a, b, c])).toEqual(heads);
      expect(await store.facts.heads(scopeOf(bob), [a])).toEqual(new Map());

      clock.advance(1000);
      const later = { ...target, at: clock.now() };
      const inside = await store.unit(later, async (unit) => {
        await unit.facts.restore(b, "unconfirmed");
        return unit.facts.heads([a, b]);
      });
      expect(inside).toEqual(new Map([[a, b]]));
      expect(await store.facts.get(scope, a)).toEqual(linked);
      expect(await store.facts.get(scope, b)).toMatchObject({ status: "unconfirmed" });
    });

    test("a question never admits a fact, an identifier it holds does, and a kept fact carries what standing reads", async () => {
      const draft = fact(alice, "Refund batch BATCH-02 settles at two in the morning");
      const question = "why did ZEP-9 trip the zeppelin quorum?";
      const target = targetOf(alice, clock.now());
      await store.unit(target, async (unit) => {
        const content = { ...draft.content, question, idents: ["batch-02"] };
        await unit.facts.insert({ ...draft, content });
      });
      const asked = query(alice, "zeppelin quorum");
      expect(await store.search.passes({ ...asked, idents: ["zep-9"] })).toEqual([]);
      expect(await store.search.passes({ ...asked, idents: ["zep-9", "batch-02"] })).toEqual([
        { factId: draft.id, pass: "identifier", rank: 1 },
      ]);
      const covered = query(alice, "refund batch zeppelin");
      const kept = {
        factId: draft.id,
        cosine: null,
        lexemeCoverage: 2 / 3,
        status: "unconfirmed",
        author: alice.principalId,
        updatedAt: clock.now(),
      };
      expect(await store.search.candidates(covered, [draft.id])).toEqual([
        { ...kept, flagged: false, confirmedAt: null },
      ]);
      await store.unit(target, async (unit) => {
        const check = { factId: draft.id, at: clock.now(), sourceVersion: null, checked: null };
        await unit.review.confirm({ ...check, person: alice.principalId });
        const stale = { factId: draft.id, kind: "marked_stale" as const, raisedBy: actorOf(bob) };
        await unit.review.raiseFlag({ ...stale, id: ids.uuid() });
      });
      expect(await store.search.candidates(covered, [draft.id])).toEqual([
        { ...kept, flagged: true, confirmedAt: clock.now() },
      ]);
    });

    test("confirmations and flags are one per person and kind, and a correction clears other people's", async () => {
      const id = await publish(alice, "Feature flags are read once at start-up");
      const target = targetOf(alice, clock.now());
      const check = {
        factId: id,
        at: clock.now(),
        sourceVersion: "a41d07c",
        checked: "read config.ts",
      };
      const flag = { factId: id, kind: "marked_stale" as const };
      const raisedBy = { kind: "person" as const, id: alice.principalId };
      const raised = await store.unit(target, async (unit) => {
        await unit.review.confirm({ ...check, person: alice.principalId });
        await unit.review.confirm({ ...check, person: alice.principalId });
        await unit.review.confirm({ ...check, person: bob.principalId });
        const first = await unit.review.raiseFlag({ ...flag, id: ids.uuid(), raisedBy });
        const second = await unit.review.raiseFlag({ ...flag, id: ids.uuid(), raisedBy });
        return [first, second];
      });
      expect(raised).toEqual([true, false]);
      expect(await store.review.confirmations(scopeOf(alice), [id])).toHaveLength(2);
      expect(
        (await store.review.openFlags(scopeOf(alice), [id])).map((entry) => entry.kind),
      ).toEqual(["marked_stale"]);
      const cleared = await store.unit(target, (unit) =>
        unit.review.clearConfirmations(id, alice.principalId),
      );
      expect(cleared).toBe(1);
    });

    test("a secret's hash names its caller, as its own kind only, until the credential is revoked, and its use is stamped once a minute", async () => {
      const { directory } = store;
      const credential = { orgId: alice.orgId, id: ids.uuid(), principalId: alice.principalId };
      const made = clock.now();
      const token = { ...credential, kind: "agent" as const, label: "test", createdAt: made };
      await directory.addCredential({ ...token, tokenHash: hash("t1") });
      const held = () => directory.credentials(alice.orgId, alice.principalId);
      expect(await held()).toMatchObject([{ kind: "agent", createdAt: made, lastUsedAt: null }]);
      const signedIn = { ...alice, credentialId: credential.id };
      const as = (secret: string, kind: "agent" | "person" = "agent") =>
        directory.callerByTokenHash(hash(secret), kind, clock.now());
      expect(await as("t1")).toEqual(signedIn);
      expect(await as("t2")).toBeNull();
      // What a harness sends does not sign a person in, and a person's key calls no tool.
      expect(await as("t1", "person")).toBeNull();
      const key = { ...token, id: ids.uuid(), kind: "person" as const, tokenHash: hash("k1") };
      await directory.addCredential(key);
      expect(await as("k1")).toBeNull();
      expect(await as("k1", "person")).toEqual({ ...alice, credentialId: key.id });
      clock.advance(30_000);
      await as("t1");
      expect((await held())[0]?.lastUsedAt).toEqual(made);
      clock.advance(31_000);
      await as("t1");
      expect((await held())[0]?.lastUsedAt).toEqual(clock.now());
      expect(await directory.callerOfCredential(alice.orgId, credential.id)).toEqual(signedIn);
      expect(await directory.callerOf(alice.orgId, alice.principalId)).toEqual(alice);
      expect(await directory.callerOf(alice.orgId, bob.principalId)).toBeNull();
      expect(await directory.revokeCredential(alice.orgId, credential.id, clock.now())).toBe(true);
      expect(await as("t1")).toBeNull();
      expect(await directory.callerOfCredential(alice.orgId, credential.id)).toBeNull();
      expect(await as("k1", "person")).not.toBeNull();
    });

    test("names are listed in byte order, whatever the database collates by", async () => {
      const at = clock.now();
      const [here, hyphen] = [PROJECT, "github.com/acme-b/api"];
      for (const key of [here, hyphen]) {
        await store.projects.ensure(bob.orgId, { kind: "repository", key });
        await store.projects.choose(bob.orgId, bob.principalId, key, "private");
      }
      const listed = await store.projects.listOf(bob.orgId, bob.principalId);
      expect(listed.map((project) => project.key)).toEqual([hyphen, here]);
      const who = { orgId: bob.orgId, principalId: bob.principalId, conversationId: null };
      const calls = { firstCallAt: at, lastCallAt: at, lastSearchAt: null, lastPublishAt: null };
      const counts = {
        refusedCalls: 0,
        calls: 1,
        briefedAt: null,
        clientVersion: null,
        note: null,
        ...UNREAD,
      };
      for (const clientName of ["claude-code", "Zed"]) {
        const session = { ...who, clientName, project: here, id: ids.uuid(), displayId: "s-1" };
        await store.sessions.open({ ...session, ...calls, ...counts });
      }
      const activity = await store.sessions.activity(bob.orgId, bob.principalId, at);
      expect(activity.map((row) => row.clientName)).toEqual(["Zed", "claude-code"]);
    });

    sessionCases({ store: () => store, person: () => alice, clock, ids });

    hostingCases({
      store: () => store,
      people: () => [alice, bob],
      now: () => clock.now(),
      fact,
    });
  });
}
