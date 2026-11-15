/**
 * The model step on a real store, with a scripted model: what a session that ended leaves behind,
 * and what of a model's answer is stored, kept out, merged or flagged.
 */
import { activityReport, SESSION_IDLE_MS } from "@uketsugi/core";
import { expect, test } from "vitest";
import { candidate, FOUND, scripted, serverWith } from "./digest-world.ts";
import { describeUseCases } from "./use-case-world.ts";

describeUseCases("what the model step writes", (w) => {
  const { clock } = w;

  test("with no model nothing is armed, and a session's end leaves only its note", async () => {
    const server = serverWith(w, undefined);
    await server.call("publish_fact", { claim: "Deploys run from main", citations: "ci.yml:3" });
    await server.end(FOUND);
    clock.advance(SESSION_IDLE_MS + 1);
    await server.drain();
    expect(await server.session()).toMatchObject({
      digestedAt: null,
      modelTokens: { input: 0, output: 0 },
    });
    expect(await w.store.jobs.counts()).toEqual({ waiting: 0, dead: 0 });
    const { recent } = await activityReport(server.ports, w.owner, { days: 1 });
    expect(recent.map((session) => session.digest)).toEqual([null]);
  });

  test("a session that published nothing leaves cited facts a later session finds, written by the job in its person's name", async () => {
    const runner = scripted({
      extract: () => ({
        facts: [
          candidate(
            "The webhook queue retries a failed delivery five times with exponential backoff capped at 30 seconds",
            ["src/queue/retry.ts:40-62"],
            "How often does the webhook queue retry a failed delivery?",
          ),
          candidate("Deliveries are deduplicated on the event id", ["src/queue/dedupe.ts:1-9"]),
        ],
      }),
    });
    const server = serverWith(w, runner);
    await server.call("search_facts", { query: "how are webhooks retried" });
    await server.end(FOUND);
    await server.drain();

    const ended = await server.session();
    const [extract] = runner.askedFor("digest.extract");
    expect(JSON.parse(extract?.material ?? "")).toEqual({
      said: [{ request: null, answer: FOUND }],
      recorded: [],
    });
    expect(server.reports).toEqual([
      expect.objectContaining({ session: ended.displayId, read: 1, written: 2, chose: false }),
    ]);

    clock.advance(SESSION_IDLE_MS + 1);
    const found = await server.call("search_facts", { query: "webhook queue retry backoff" });
    const last = found.brief?.last_session;
    expect(last).toMatchObject({ session: ended.displayId, published: [] });
    expect(last?.digested?.map((entry) => entry.claim).sort()).toEqual([
      "Deliveries are deduplicated on the event id",
      "The webhook queue retries a failed delivery five times with exponential backoff capped at 30 seconds",
    ]);
    expect(found.text).toContain(
      "Facts a model wrote from what it left, which nobody has checked:",
    );
    expect(found.text).toContain("(written by a model, unchecked)");
    const [fact] = found.facts;
    expect(fact).toMatchObject({
      author: "you",
      from_session: ended.displayId,
      trust: "unreviewed",
    });
    expect(fact?.citations).toEqual([
      { ref: "src/queue/retry.ts:40-62", kind: "file", class: "checkable" },
    ]);
    expect(found.text).toContain(`by you, written by a model from session ${ended.displayId}`);

    const stored = await w.factOf(fact?.id ?? "");
    expect(stored).toMatchObject({ author: w.owner.principalId, digestSession: ended.id });
    expect(await w.eventsOf(stored.id)).toEqual([
      expect.objectContaining({
        kind: "FactPublished",
        actor: { kind: "job", job: "digest", runner: "endpoint" },
        session: ended.id,
      }),
    ]);
    // The second candidate cited lines the record does not give: it keeps the file and loses them.
    const other = last?.digested?.find((entry) => entry.id !== fact?.id);
    expect((await w.factOf(other?.id ?? "")).citations).toEqual([
      {
        citation: { kind: "file", repo: server.project, path: "src/queue/dedupe.ts" },
        class: "checkable",
      },
    ]);
  });

  test("a candidate that cites nothing the record names, cites nothing others can open, or repeats what is held is not stored", async () => {
    const held = "Deliveries are deduplicated on the event id";
    const runner = scripted({
      extract: () => ({
        facts: [
          candidate("The cap is 30 seconds", []),
          candidate("The queue is drained by a cron job", ["src/cron/drain.ts:1"]),
          candidate("The provider throttles bursts", ["the agent said so"]),
          candidate("The dashboard is at an internal address", ["http://10.0.0.7/queue"]),
          candidate("deliveries are deduplicated on the event id.", ["src/queue/dedupe.ts"]),
          candidate("x".repeat(2001), ["src/queue/retry.ts"]),
          { claim: "No citations field at all" },
          candidate("The retry cap was raised from 10 seconds in one commit", ["4f2a9c1d"]),
        ],
      }),
    });
    const server = serverWith(w, runner);
    const before = await server.call("publish_fact", { claim: held, citations: "notes.md:1" });
    await server.end(`${FOUND} The dashboard is at http://10.0.0.7/queue for now.`);
    await server.drain();

    expect(server.reports[0]).toMatchObject({
      written: 1,
      refused: { uncited: 4, repeat: 1, invalid: 2 },
    });
    const facts = await w.store.facts.list(w.scope, { project: server.project, limit: 50 });
    expect(facts.map((fact) => fact.claim).sort()).toEqual([
      held,
      "The retry cap was raised from 10 seconds in one commit",
    ]);
    expect(facts.find((fact) => fact.id === before.id)?.digestSession).toBeNull();
    // The model was told what the session had already recorded.
    expect(JSON.parse(runner.asked[0]?.material ?? "")).toMatchObject({ recorded: [held] });
  });

  test("a model's fact is scanned like any write", async () => {
    const runner = scripted({
      extract: () => ({
        facts: [
          candidate("The deploy job signs in with ghp_0123456789abcdefghijklmnopqrstuvwxyzAB", [
            "deploy/release.sh",
          ]),
        ],
      }),
    });
    const server = serverWith(w, runner);
    await server.end(
      `The deploy job in deploy/release.sh signs in with a token it reads from the vault. ${FOUND}`,
    );
    await server.drain();
    const [fact] = await w.store.facts.list(w.scope, { project: server.project, limit: 5 });
    expect(fact?.claim).toBe("The deploy job signs in with [redacted:github-token]");
  });

  test("a model's judgement keeps a rewording out, merges the agent's own rewording, and flags a contradiction", async () => {
    const runner = scripted({
      extract: () => ({
        facts: [
          candidate("A failed delivery is retried five times by the webhook queue", [
            "src/queue/retry.ts",
          ]),
          candidate("The webhook queue retries a failed delivery three times", [
            "src/queue/retry.ts:40-62",
          ]),
        ],
      }),
      judge: ({ pairs }) => ({
        verdicts: pairs.map(({ n, a, b }) => ({
          n,
          verdict:
            a.includes("three times") !== b.includes("three times")
              ? "contradicts"
              : a.includes("nightly") === b.includes("nightly")
                ? "same"
                : "different",
        })),
      }),
    });
    const server = serverWith(w, runner);
    const held = await server.call("publish_fact", {
      claim: "The webhook queue retries a failed delivery five times",
      citations: "docs/queue.md:12",
    });
    const nightly = await server.call("publish_fact", {
      claim: "Refunds are settled nightly by the batch job",
      citations: "src/refunds.ts:9",
    });
    // An earlier session, ended with too little said for a model to be asked anything.
    await server.end("Recorded both.");
    await server.drain();
    expect(runner.asked).toEqual([]);
    const reworded = await server.call("publish_fact", {
      claim: "The batch job settles refunds nightly",
      citations: "docs/refunds.md:2",
    });
    await server.end(FOUND);
    await server.drain();

    expect(server.reports.at(-1)).toMatchObject({
      written: 1,
      refused: { repeat: 1 },
      merged: 1,
      flagged: 2,
    });
    // The agent's rewording and the fact it reworded are one fact now, under a ruling its author can undo.
    expect(await w.factOf(nightly.id)).toMatchObject({ supersededBy: reworded.id });
    const [ruling] = await w.store.review.rulingsOf(w.scope, [nightly.id]);
    expect(ruling).toMatchObject({
      decision: "merge_duplicate",
      decidedBy: { kind: "job", job: "digest", runner: "endpoint" },
      reasons: ["same_meaning"],
    });
    // The contradicting candidate is stored, and both sides say there is doubt.
    const facts = await w.store.facts.list(w.scope, { project: server.project, limit: 50 });
    const three = facts.find((fact) => fact.claim?.includes("three times"));
    expect(await w.flagsOf(three?.id ?? "")).toEqual(["possible_contradiction"]);
    expect(await w.flagsOf(held.id)).toEqual(["possible_contradiction"]);
    expect(facts.some((fact) => fact.claim?.startsWith("A failed delivery"))).toBe(false);

    // The next agent settles it: a check clears the doubt on the fact that holds, and correcting
    // the other takes its flag with the wording it was raised on.
    const checked = await server.call("update_fact", {
      id: held.id,
      confirm: { checked: "read src/queue/retry.ts: five attempts" },
    });
    expect(checked.flags).toEqual([]);
    const corrected = await server.call("update_fact", {
      id: three?.id,
      claim: "The webhook queue gives up on a delivery after its fifth failed attempt",
    });
    expect(corrected.flags).toEqual([]);
    // A fact its author's agent rewrote is no longer one a model wrote.
    expect((await w.factOf(three?.id ?? "")).digestSession).toBeNull();
  });
});
