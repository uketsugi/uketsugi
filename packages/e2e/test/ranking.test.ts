import { noConfidentMatch, NOTHING_FOUND } from "@uketsugi/contracts";
import { createApp, type App, type Caller, type Embedder, type Store } from "@uketsugi/core";
import { openLocalPorts } from "@uketsugi/server";
import { FakeClock, FakeEmbedder, FakeIdGen, toolCaller, type Called } from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const CLIENT = { name: "ranking-test", version: null, conversationId: null };

interface Candidate {
  id: string;
  position: number;
  ranks: Record<string, number>;
  relevance: number;
  cosine: number | null;
  standing: { status: number; flagged: number; recency: number };
  score: number;
}
type Found = Called<"search_facts"> & { explain: { candidates: Candidate[] } };
type Local = Awaited<ReturnType<typeof openLocalPorts>>;

describe("golden ranking: what a search must and must not return", () => {
  let store: Store;
  let app: App;
  let owner: Caller;
  /** Each test searches a project of its own, so two stores serve them all. */
  let project = "";
  let plain: Local;
  let modelled: Local;
  const ids = new FakeIdGen(3);
  const clock = new FakeClock();

  beforeAll(async () => {
    plain = await openLocalPorts({});
    modelled = await openLocalPorts({ embedder: new FakeEmbedder() });
  });
  afterAll(() => Promise.all([plain.close(), modelled.close()]));

  /** Points the test at a new project on a server's own ports, with a clock that stands still. */
  function open(local: Local = plain, embedder: Embedder | null = local.ports.embedder): void {
    project = `github.com/acme/ranking-${ids.uuid().slice(0, 13)}`;
    ({ owner } = local);
    ({ store } = local.ports);
    const rethrow = (error: unknown): never => {
      throw error;
    };
    app = createApp({ ...local.ports, clock, embedder }, { onError: rethrow });
  }

  /** The calls of a person in the test's project. */
  const as = (caller: Caller) => toolCaller(app, caller, CLIENT, project);

  async function publish(claim: string, more: Record<string, unknown> = {}): Promise<string> {
    const args = { claim, citations: ["src/billing/retry.ts:10-20"], ...more };
    return (await as(owner)("publish_fact", args)).id;
  }

  const search = (query: string, more: Record<string, unknown> = {}, caller = owner) =>
    as(caller)("search_facts", { query, explain: true, ...more }) as Promise<Found>;

  test("a flagged fact with closer wording does not outrank a clean one", async () => {
    open();
    const closer = await publish("The webhook retry backoff is exponential over five attempts");
    const clean = await publish("Each webhook retry uses a backoff of two seconds at first");
    const query = "exponential webhook retry backoff";
    const before = await search(query);
    expect(before.facts.map((fact) => fact.id)).toEqual([closer, clean]);

    await as(owner)("update_fact", { id: closer, flag: "stale" });
    const after = await search(query);
    expect(after.facts.map((fact) => fact.id)).toEqual([clean, closer]);
    const [first, second] = after.explain.candidates;
    expect(second).toMatchObject({
      id: closer,
      ranks: { keyword: 1, trigram: 1 },
      standing: { status: 1, flagged: 0.8, recency: 1 },
    });
    expect(first?.standing).toEqual({ status: 1, flagged: 1, recency: 1 });
    expect(second?.relevance).toBeGreaterThan(first?.relevance ?? 0);
    expect(second?.score).toBeCloseTo((second?.relevance ?? 0) * 0.8, 6);
  });

  test("a fact outside the caller's audiences or project is never a candidate", async () => {
    open();
    await publish("Refunds above 500 EUR need a second approver");
    const query = "refunds second approver";
    expect((await search(query)).matched).toBe(1);

    const elsewhere = await search(query, { project: "github.com/acme/other" });
    const stranger = await store.directory.ensurePrincipal({
      subject: "someone-else",
      displayName: "someone else",
      orgId: ids.uuid(),
      principalId: ids.uuid(),
      audienceId: ids.uuid(),
    });
    const outside = [
      elsewhere,
      await search(query, {}, stranger),
      await search(query, {}, { ...owner, visibleAudienceIds: [stranger.privateAudienceId] }),
      await search(query, {}, { ...owner, visibleAudienceIds: [] }),
    ];
    for (const found of outside) {
      expect(found).toMatchObject({ matched: 0, shown: 0, facts: [], message: NOTHING_FOUND });
      expect(found.explain.candidates).toEqual([]);
    }
  });

  test("the question field alone never admits a fact, and adds to one its own text admitted", async () => {
    open();
    const asked = await publish("Exports run at 02:00 UTC", {
      question: "When does the warehouse export start, and what does PAY-4021 mean?",
    });
    const plain = await publish("Exports run from the reporting replica");

    for (const query of ["PAY-4021", "warehouse start", "what does PAY-4021 mean"]) {
      expect(await search(query)).toMatchObject({ matched: 0, facts: [] });
    }
    const found = await search("when does the warehouse export run");
    expect(found.facts.map((fact) => fact.id)).toEqual([asked, plain]);
    expect(found.explain.candidates[0]?.ranks).toMatchObject({ keyword: 1 });
  });

  test("a weak match is shown under a line that says it is weak, never under the nothing-found reply", async () => {
    open();
    const id = await publish("Sessions expire after thirty minutes of inactivity");
    const found = await search("does the session cookie survive a browser restart");
    const lead =
      "no confident match · 1 weak match below, check it before relying on it · publish what you work out, with your question";
    expect(noConfidentMatch(1)).toBe(lead);
    expect(noConfidentMatch(3)).toContain(
      "3 weak matches below, check them before relying on them",
    );
    expect(found).toMatchObject({
      matched: 1,
      shown: 1,
      confidence: "low",
      message: lead,
      facts: [{ id }],
      explain: { confidence: { confidence: "low", test: "none" } },
    });
    expect(found.text.split("\n").slice(0, 2)).toEqual([
      lead,
      "1 matched · 1 shown · confidence low",
    ]);
    expect(found.text).not.toContain("nothing found");
    const none = await search("kubernetes pod restarts");
    expect(none).toMatchObject({ matched: 0, shown: 0, message: NOTHING_FOUND });
    expect(none.text.split("\n")[0]).toBe(NOTHING_FOUND);
    const strong = await search("when do sessions expire");
    expect(strong).toMatchObject({ confidence: "strong", facts: [{ id }] });
    expect(strong.message).toBeUndefined();
  });

  test("the vector pass ranks a fact by its cosine, and a search without a vector says so", async () => {
    open(modelled);
    const claim = "Dunning retries a declined card on days 1, 3, 5 and 7";
    const question = "How often is a declined card retried?";
    const id = await publish(claim, { question });

    // A fact's vector is made from its question, its claim and its citation: the three together are it.
    const whole = `${question}\n${claim}\nsrc/billing/retry.ts:10-20`;
    const near = await search(whole.toUpperCase());
    expect(near).toMatchObject({ degraded: [], confidence: "strong", facts: [{ id }] });
    expect(near.explain.candidates[0]).toMatchObject({ ranks: { vector: 1 } });
    expect(near.explain.candidates[0]?.cosine).toBeCloseTo(1, 3);
    const byClaim = await search(claim);
    expect(byClaim.explain.candidates[0]?.cosine).toBeLessThan(0.999);
    expect((await search("kubernetes pod restarts")).matched).toBe(0);

    const failing = { model: "none", dims: 384, embed: () => Promise.reject(new Error("down")) };
    open(modelled, failing);
    await publish("Refund batches settle nightly at two");
    const lexical = await search("when do refund batches settle");
    expect(lexical).toMatchObject({ matched: 1, degraded: ["embedder_unavailable"] });
  });
});
