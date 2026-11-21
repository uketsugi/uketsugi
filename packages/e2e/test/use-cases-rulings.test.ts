/** The use cases that settle facts against each other: merges and their rulings, reverts and redaction. */
import { createWorker, redactFact, revertRuling, type CorePorts } from "@uketsugi/core";
import type { ToolCaller } from "@uketsugi/testkit";
import { expect, test } from "vitest";
import { describeUseCases, PROJECT } from "./use-case-world.ts";

const NO_HASH = "0".repeat(64);

describeUseCases("merges, reverts and redaction", (w) => {
  const { clock, embedder, plain, embedding, portsWith } = w;
  const { publish, factOf, eventsOf, flagsOf, takeJobs, runJobs } = w;

  test("duplicates merge under a ruling of the job's, and the ruling reverts", async () => {
    const worker = createWorker(portsWith(embedder));
    const first = await publish("Refunds are settled nightly by the batch job", "src/refunds.ts:9");
    clock.advance(1_000);
    const second = await publish(
      "refunds are settled nightly, by the batch job.",
      "docs/refunds.md:2",
    );
    expect(second).toMatchObject({ created: true, similar: [{ id: first.id }] });
    await worker.drain();

    expect(await factOf(first.id)).toMatchObject({
      status: "superseded",
      supersededBy: second.id,
    });
    const paths = async () =>
      (await factOf(second.id)).citations.map(({ citation }) =>
        citation.kind === "file" ? citation.path : citation.kind,
      );
    expect(await paths()).toEqual(["docs/refunds.md", "src/refunds.ts"]);
    expect((await eventsOf(first.id)).at(-1)).toMatchObject({
      kind: "FactSuperseded",
      actor: { kind: "job", job: "consolidate", runner: "rules" },
    });
    const [ruling] = await w.store.review.rulingsOf(w.scope, [first.id]);
    expect(ruling).toMatchObject({
      decision: "merge_duplicate",
      decidedBy: { kind: "job", job: "consolidate", runner: "rules" },
      reasons: ["same_words"],
      revertedBy: null,
    });

    expect(await revertRuling(portsWith(null), w.owner, ruling?.id ?? "")).toMatchObject({
      reverted: true,
    });
    expect(await factOf(first.id)).toMatchObject({ status: "unconfirmed", supersededBy: null });
    expect(await paths()).toEqual(["docs/refunds.md"]);
    const rulings = await w.store.review.rulingsOf(w.scope, [first.id]);
    expect(rulings.map((entry) => [entry.decision, entry.decidedBy.kind])).toEqual([
      ["merge_duplicate", "job"],
      ["revert", "person"],
    ]);
    expect(rulings[0]?.revertedBy).toBe(rulings[1]?.id);

    // A person set the fact apart: the rule leaves it alone, and a second revert changes nothing.
    await plain("update_fact", { id: second.id, detail: "See the settlement runbook." });
    await worker.drain();
    expect(await factOf(first.id)).toMatchObject({ status: "unconfirmed" });
    expect(await revertRuling(portsWith(null), w.owner, ruling?.id ?? "")).toMatchObject({
      reverted: false,
    });
  });

  /** Publishes wordings of one claim in turn, each with a citation of its own, merging as it goes. */
  async function mergedInTurn(claim: string, as: ToolCaller, ports: CorePorts): Promise<string[]> {
    const made: string[] = [];
    for (const [n, mark] of ["", ".", "!"].entries()) {
      clock.advance(1_000);
      made.push((await publish(`${claim}${mark}`, `docs/merged-${n}.md:1`, as)).id);
      await runJobs(ports);
    }
    return made;
  }

  test("a fact is embedded again when a merge or a give-back changes what it cites", async () => {
    const ports = portsWith(embedder);
    const [first = "", second = "", third = ""] = await mergedInTurn(
      "Thumbnails are rendered at three sizes",
      embedding,
      ports,
    );
    /** The cosine of a fact's stored vector with the vector of what the fact now says and cites. */
    const cosineOf = async (id: string): Promise<number | null | undefined> => {
      const [shown] = (await plain("search_facts", { id })).facts;
      const text = [shown?.claim, ...(shown?.citations ?? []).map((cited) => cited.ref)];
      const [vector = null] = await embedder.embed([text.join("\n")]);
      const tuning = { vectorCutoff: 0, admissionCoverage: 0, trigramThreshold: 0, passLimit: 5 };
      const asked = {
        scope: w.scope,
        project: PROJECT,
        query: "thumbnails",
        idents: [],
        ...tuning,
      };
      const [row] = await w.store.search.candidates(
        { ...asked, embedding: vector === null ? null : { model: embedder.model, vector } },
        [id],
      );
      return row?.cosine;
    };
    expect((await factOf(third)).citations).toHaveLength(3);
    expect(await cosineOf(third)).toBeCloseTo(1, 5);

    const [ruling] = await w.store.review.rulingsOf(w.scope, [first]);
    await revertRuling(ports, w.owner, ruling?.id ?? "");
    await runJobs(ports);
    expect((await factOf(third)).citations).toHaveLength(2);
    expect(await cosineOf(third)).toBeCloseTo(1, 5);
    expect(await cosineOf(first)).toBeCloseTo(1, 5);
    expect((await factOf(second)).status).toBe("superseded");
  });

  test("redacting a merged fact leaves no hash of its citation in a later merge's event", async () => {
    const ports = portsWith(null);
    const [first = "", second = "", third = ""] = await mergedInTurn(
      "The quokka service needs a quorum of five",
      plain,
      ports,
    );
    const takenOf = async (id: string) => {
      const merge = (await eventsOf(id)).find((event) => event.kind === "FactSuperseded");
      return (merge?.payload.taken ?? []) as string[];
    };
    const fromFirst = await takenOf(first);
    expect(fromFirst).toHaveLength(1);
    const carried = await takenOf(second);
    expect(carried).toHaveLength(2);
    expect(carried).toEqual(expect.arrayContaining(fromFirst));

    await redactFact(ports, w.owner, { id: first });
    const own = carried.filter((taken) => !fromFirst.includes(taken));
    expect(await takenOf(second)).toEqual(own);
    expect((await factOf(third)).citations).toHaveLength(2);

    // What the second fact gave is still on record: undoing its merge gives it back.
    const [ruling] = await w.store.review.rulingsOf(w.scope, [second]);
    await revertRuling(ports, w.owner, ruling?.id ?? "");
    expect((await factOf(third)).citations).toHaveLength(1);
    expect((await factOf(second)).citations).toHaveLength(1);
  });

  test("a redaction takes the text out of every structure that held it and leaves a stub", async () => {
    const worker = createWorker(portsWith(embedder));
    const claim = "The zyzzyva service signs exports with the quarterly key";
    const quoted = {
      kind: "web",
      url: "https://docs.example.com/zyzzyva",
      quote: "zyzzyva signs",
    };
    const earlier = await publish("the zyzzyva service signs exports, with the quarterly key");
    await worker.drain();
    clock.advance(1_000);
    const fact = await publish(claim, [quoted], embedding);
    await worker.drain();
    expect(await factOf(earlier.id)).toMatchObject({ supersededBy: fact.id });
    const citing = await publish("Exports are signed before upload", [fact.id]);
    const confirm = { checked: "read the zyzzyva signer" };
    await plain("update_fact", { id: fact.id, confirm, flag: "stale" });
    await plain("update_fact", { id: fact.id, detail: "zyzzyva is in services/signing." });

    expect(await redactFact(portsWith(null), w.owner, { id: fact.id })).toEqual({
      id: fact.id,
      redacted: true,
    });
    for (const id of [fact.id, earlier.id]) {
      const stub = await factOf(id);
      const text = { claim: null, detail: null, question: null, citations: [], embedded: false };
      expect(stub).toMatchObject({ ...text, contentHash: NO_HASH, claimHash: NO_HASH });
      expect(stub.redactedAt).toEqual(clock.now());
      const events = await eventsOf(id);
      expect(events.at(-1)?.kind).toBe("FactRedacted");
      const earlierEvents = events.slice(0, -1);
      expect(JSON.stringify(earlierEvents.map((event) => event.payload))).not.toMatch(
        /contentHash|claimHash|before|after|taken/,
      );
      expect(await takeJobs(id)).toEqual([]);
    }
    const tuning = { vectorCutoff: 0, admissionCoverage: 0, trigramThreshold: 0, passLimit: 50 };
    const [vector] = await embedder.embed([claim]);
    const query = {
      scope: w.scope,
      project: PROJECT,
      query: "zyzzyva signs exports",
      idents: ["zyzzyva"],
    };
    const hits = await w.store.search.passes({
      ...query,
      embedding: vector === undefined ? null : { model: embedder.model, vector },
      ...tuning,
    });
    expect(hits.map((row) => row.factId)).not.toContain(fact.id);
    expect(hits.map((row) => row.factId)).not.toContain(earlier.id);
    const listed = await w.store.facts.list(w.scope, { project: PROJECT, limit: 500 });
    // The list still holds both, as stubs.
    const stubs = listed.filter((entry) => entry.claim === null).map((entry) => entry.id);
    expect(stubs).toEqual(expect.arrayContaining([fact.id, earlier.id]));
    expect(await w.store.review.confirmations(w.scope, [fact.id])).toEqual([]);
    expect(await flagsOf(fact.id)).toEqual([]);
    expect(await flagsOf(citing.id)).toEqual(["source_changed"]);

    const count = (await eventsOf(fact.id)).length;
    await redactFact(portsWith(null), w.owner, { id: fact.id });
    expect(await eventsOf(fact.id)).toHaveLength(count);
  });
});
