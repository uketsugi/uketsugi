/** The write use cases: a publish, a correction, the limits, a session's note and the follow-up jobs. */
import { LIMITS } from "@uketsugi/contracts";
import { createWorker, type Embedder } from "@uketsugi/core";
import { targetOf } from "@uketsugi/testkit";
import { expect, test } from "vitest";
import { CLIENT, describeUseCases, PROJECT } from "./use-case-world.ts";

const SECRET = `ghp_${"16C7e42F292c6912E7710c838347Ae178B4a"}`;
/** A conversation of a harness whose hook names the project. */
const conversation = (id: string) => ({ client: "claude-code", id, project: PROJECT });

describeUseCases("the write use cases", (w) => {
  const { clock, ids, embedder, plain, embedding, portsWith, callsOn } = w;
  const { publish, factOf, eventsOf, flagsOf, takeJobs } = w;

  test("a publish commits the fact, its event and its follow-up job in one unit; with no model it leaves no embed job", async () => {
    const { id, created } = await publish("Invoice webhooks retry five times with backoff");
    expect(created).toBe(true);
    expect(await factOf(id)).toMatchObject({ status: "unconfirmed", embedded: false });
    const [event, ...others] = await eventsOf(id);
    expect(others).toEqual([]);
    expect(event).toMatchObject({ kind: "FactPublished", actor: { id: w.owner.principalId } });
    expect(event?.payload).toHaveProperty("contentHash", (await factOf(id)).contentHash);
    expect(await takeJobs(id)).toEqual(["consolidate"]);
  });

  test("a repeated publish returns the same fact and writes nothing", async () => {
    const first = await publish("Handlers are idempotent on the event id");
    const again = await publish("handlers are  idempotent on the EVENT id", "src/retry.ts:10-20");
    expect(again).toMatchObject({ id: first.id, created: false });
    expect(await eventsOf(first.id)).toHaveLength(1);
    expect((await factOf(first.id)).citations).toHaveLength(1);
  });

  test("the same claim published again with a citation the fact lacks keeps that citation", async () => {
    const first = await publish("Handlers are retried on the event id");
    await w.plain("update_fact", { id: first.id, confirm: { checked: "read the handler" } });
    // Somebody else's check is what confirms a fact: stand it in as that.
    const at = clock.now();
    const own = { orgId: w.owner.orgId, audienceId: w.owner.privateAudienceId, at };
    await w.store.unit(own, (unit) => unit.facts.setStatus(first.id, "confirmed"));
    expect(await factOf(first.id)).toMatchObject({ status: "confirmed" });
    const again = await publish("handlers are retried on the EVENT id", "src/other.ts:3");
    // It was confirmed and is not now: the result says so, for the agent to check it again.
    expect(again).toMatchObject({
      id: first.id,
      created: false,
      status: "unconfirmed",
      lost_confirmation: true,
    });
    expect(again.citations).toHaveLength(2);
    expect((await factOf(first.id)).citations).toHaveLength(2);
    expect((await eventsOf(first.id)).at(-1)).toMatchObject({ kind: "FactRewritten" });
    // The same two again bring nothing, change nothing and say nothing of a confirmation.
    const events = (await eventsOf(first.id)).length;
    const repeat = await publish("Handlers are retried on the event id", "src/other.ts:3");
    expect(await eventsOf(first.id)).toHaveLength(events);
    expect(repeat).not.toHaveProperty("lost_confirmation");
    // A fact that was not confirmed has nothing to lose by a new citation.
    const plain = await publish("The queue drains before the deploy", "src/drain.ts:1");
    const more = await publish("the queue drains before the deploy", "src/drain.ts:9");
    expect(more).toMatchObject({ id: plain.id, status: "unconfirmed" });
    expect(more).not.toHaveProperty("lost_confirmation");
  });

  test("one claim published in two projects is two facts", async () => {
    const claim = "The retry budget is three attempts";
    const here = await publish(claim);
    const other = "github.com/acme/ledger";
    const there = await plain("publish_fact", {
      project: other,
      claim,
      citations: "a.ts:1",
    });
    expect(there.created).toBe(true);
    expect(there.id).not.toBe(here.id);
    expect(await factOf(there.id)).toMatchObject({ project: other, claim });
    const again = await plain("publish_fact", {
      project: other,
      claim,
      citations: "a.ts:1",
    });
    expect(again).toMatchObject({ id: there.id, created: false });
  });

  test("a text over its limit is refused by name, and nothing of it is stored or echoed", async () => {
    const before = (await w.store.review.events(w.scope, w.owner.privateAudienceId, 0, 500)).length;
    const long = "word ".repeat(380_000);
    const refused = async (tool: string, args: Record<string, unknown>) => {
      const result = await w.app.callTool(w.owner, tool, { project: PROJECT, ...args }, CLIENT);
      expect(result.structuredContent).toMatchObject({ error: { code: "invalid_input" } });
      expect(JSON.stringify(result)).not.toContain("word word");
      return result.content[0]?.text ?? "";
    };
    const citations = "src/retry.ts:1";
    const ok = "The gateway retries idempotent requests";
    expect(await refused("publish_fact", { claim: ok, detail: long, citations })).toContain(
      "detail is 1900000 characters long; the most it may hold is 20000.",
    );
    expect(await refused("publish_fact", { claim: long, citations })).toContain("claim is");
    expect(await refused("publish_fact", { claim: ok, question: long, citations })).toContain(
      "question is",
    );
    expect(await refused("publish_fact", { claim: ok, citations: [long] })).toContain(
      "citations is",
    );
    expect(await refused("search_facts", { query: long })).toContain("query is");
    const { id } = await publish(ok);
    expect(await refused("update_fact", { id, detail: long })).toContain("detail is");
    expect(await refused("update_fact", { id, confirm: { checked: long } })).toContain(
      "confirm.checked is",
    );
    const after = await w.store.review.events(w.scope, w.owner.privateAudienceId, before, 500);
    expect(after.map((event) => event.kind)).toEqual(["FactPublished"]);
  });

  test("an event names the job and the runner that wrote it, as written", async () => {
    const subject = ids.uuid();
    const target = targetOf(w.owner, clock.now());
    const actor = { kind: "job" as const, job: "consolidate", runner: "endpoint" as const };
    const event = { subject, actor, session: null, payload: {} };
    const seq = await w.store.unit(target, async (unit) => {
      await unit.append({ ...event, kind: "TaskNoted" });
      return unit.append({ ...event, kind: "FlagCleared" });
    });
    const [read] = await w.store.review.events(w.scope, w.owner.privateAudienceId, seq - 1, 1);
    expect(read?.actor).toEqual(actor);
    expect((await w.store.review.history(w.scope, subject, 5)).map((entry) => entry.actor)).toEqual(
      [actor, actor],
    );
    expect((await w.store.tasks.history(w.scope, subject)).map((step) => step.actor)).toEqual([
      actor,
    ]);
  });

  test("a publish with a model stores the vector, the identifiers and what it cites", async () => {
    const source = await publish("The ledger lock is held for up to four seconds");
    const claim = "ECONNRESET from fs.readFile is retried by ledger-client v2.3.1";
    const { id } = await publish(claim, [source.id, "src/ledger.ts:7"], embedding);
    expect(await factOf(id)).toMatchObject({ embedded: true });
    expect(await takeJobs(id)).toEqual(["consolidate"]);
    const tuning = { vectorCutoff: 0.99, admissionCoverage: 0.6, trigramThreshold: 0.5 };
    const query = { scope: w.scope, project: PROJECT, query: "reset", embedding: null, ...tuning };
    const hits = await w.store.search.passes({ ...query, idents: ["econnreset"], passLimit: 5 });
    expect(hits).toContainEqual({ factId: id, pass: "identifier", rank: 1 });
    const target = targetOf(w.owner, clock.now());
    expect(await w.store.unit(target, (unit) => unit.facts.citing(source.id))).toEqual([id]);
  });

  test("a fact that answers the same question from the same file in other words is not called similar", async () => {
    const question =
      "How long does the gateway wait before it gives up on an upstream that has stopped answering its health checks?";
    const about = { question, citations: "src/gateway/upstream.ts:40-71" };
    const [one, other] = ["Thirty seconds", "Two minutes"];
    // What the two facts are embedded from is nearly the same text, so their vectors are close.
    const whole = (claim: string) => `${question}\n${claim}\nsrc/gateway/upstream.ts:40-71`;
    const [a, b] = await embedder.embed([whole(one), whole(other)]);
    const cosine = Array.from(a ?? [], (x, i) => x * (b?.[i] ?? 0)).reduce((sum, x) => sum + x, 0);
    expect(cosine).toBeGreaterThan(0.9);

    const first = await embedding("publish_fact", { claim: one, ...about });
    const second = await embedding("publish_fact", { claim: other, ...about });
    expect(first.created && second.created).toBe(true);
    expect(second.similar).toBeUndefined();
    const reworded = await embedding("publish_fact", { claim: "thirty  seconds.", ...about });
    expect(reworded.similar).toEqual([{ id: first.id, claim: one }]);
  });

  test("the author's correction rewrites in place, clears other people's confirmations and flags the citing fact", async () => {
    const source = await publish("Feature flags are read once at start-up");
    const citing = await publish("Flag changes need a restart", [source.id]);
    const target = targetOf(w.owner, clock.now());
    await w.store.unit(target, async (unit) => {
      const check = { factId: source.id, at: clock.now(), sourceVersion: null, checked: "read" };
      await unit.review.confirm({ ...check, person: ids.uuid() });
      await unit.facts.setStatus(source.id, "confirmed");
    });
    const before = await factOf(source.id);

    const claim = "Feature flags are read at start-up and again every five minutes";
    const updated = await plain("update_fact", { id: source.id, claim });
    expect(updated).toMatchObject({ id: source.id, status: "unconfirmed" });
    const after = await factOf(source.id);
    expect(after).toMatchObject({ claim, createdAt: before.createdAt });
    expect(await w.store.review.confirmations(w.scope, [source.id])).toEqual([]);
    expect(await flagsOf(citing.id)).toEqual(["source_changed"]);
    const rewritten = (await eventsOf(source.id)).at(-1);
    expect(rewritten).toMatchObject({
      kind: "FactRewritten",
      payload: { before: before.contentHash, after: after.contentHash },
    });

    await plain("update_fact", { id: source.id, claim });
    expect((await eventsOf(source.id)).at(-1)?.seq).toBe(rewritten?.seq);
    const checked = await plain("update_fact", {
      id: citing.id,
      confirm: { checked: "read flags.ts again" },
    });
    expect(checked).toMatchObject({ status: "unconfirmed", flags: [] });
    const move = { project: PROJECT, id: source.id, audience: "team" };
    const moved = await w.app.callTool(w.owner, "update_fact", move, CLIENT);
    expect(moved.structuredContent).toMatchObject({ error: { code: "unsupported" } });
  });

  test("a publish that supersedes the caller's own fact corrects it in place", async () => {
    const old = await publish("Exports run hourly from the reporting replica");
    const claim = "Exports run every fifteen minutes from the reporting replica";
    const corrected = await plain("publish_fact", {
      claim,
      citations: "src/exports.ts:4",
      supersedes: old.id,
    });
    expect(corrected).toMatchObject({ id: old.id, created: false, supersedes: old.id });
    expect(await factOf(old.id)).toMatchObject({ claim, status: "unconfirmed" });
    expect((await factOf(old.id)).citations).toHaveLength(1);
  });

  test("a worker with a model embeds what was published while there was none", async () => {
    const { id } = await publish("Sessions expire after thirty minutes of inactivity");
    const waiting = createWorker(portsWith(null));
    await waiting.drain();
    expect(await factOf(id)).toMatchObject({ embedded: false });
    const worker = createWorker(portsWith(embedder));
    expect(await worker.drain()).toBeGreaterThan(0);
    expect(await factOf(id)).toMatchObject({ embedded: true });
    expect(await takeJobs(id)).toEqual([]);
  });

  test("a store whose vectors another model made is embedded again by a server with this one", async () => {
    const { id } = await publish("Webhook signatures use the shared secret of the endpoint");
    await createWorker(portsWith(embedder)).drain();
    expect(await factOf(id)).toMatchObject({ embedded: true });

    // The next start has another model: its first pass sets the old vectors aside, then embeds again.
    const other: Embedder = {
      model: "another-model",
      dims: embedder.dims,
      embed: (texts) => embedder.embed(texts),
    };
    const worker = createWorker(portsWith(other));
    await w.store.jobs.embedMissing(other.model, clock.now());
    expect(await factOf(id)).toMatchObject({ embedded: false });
    expect(await worker.drain()).toBeGreaterThan(0);
    expect(await factOf(id)).toMatchObject({ embedded: true });
    // The suite's store goes back to the model the other tests use.
    await w.store.jobs.embedMissing(embedder.model, clock.now());
  });

  test("a server whose model is not the store's gives up an embed job at once, naming both models", async () => {
    await publish("Queues drain in the order the events were taken");
    const failures: { message: string; dead: boolean }[] = [];
    const worker = createWorker(portsWith(embedder), {
      onFailure: (_job, error, dead) => failures.push({ message: String(error), dead }),
    });
    await worker.drain();
    // Another server, of another model, starts later and takes the store: it owes every fact a vector.
    await w.store.jobs.embedMissing("another-model", clock.now());
    await worker.drain();
    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) {
      expect(failure.dead).toBe(true);
      expect(failure.message).toContain(`"${embedder.model}"`);
      expect(failure.message).toContain('"another-model"');
    }
    // The suite's store goes back to the model the other tests use.
    await w.store.jobs.embedMissing(embedder.model, clock.now());
  });

  test("a citation sent back as the server showed it is stored as the citation it showed, whatever its repository", async () => {
    const lib = "github.com/other/lib";
    const first = await publish("Retries follow the library's policy", [
      "src/hooks.ts:5-9",
      { kind: "pull_request", repo: lib, number: 42 },
      { kind: "file", repo: lib, path: "src/policy.ts", lines: "3" },
      { kind: "web", url: "https://example.com/policy", quote: "five attempts" },
      { kind: "person", who: "Priya", at: "last week" },
    ]);
    const shown = (await plain("search_facts", { id: first.id })).facts[0]?.citations ?? [];
    expect(shown.map((entry) => entry.ref)).toContain(`${lib} pull request 42`);

    const again = await publish("Hooks retry as the library does", shown);
    const stored = (await factOf(again.id)).citations.map((entry) => entry.citation);
    expect(stored).toEqual((await factOf(first.id)).citations.map((entry) => entry.citation));
    expect(stored).toContainEqual({ kind: "pull_request", repo: lib, number: 42 });
    expect(stored).toContainEqual({ kind: "file", repo: lib, path: "src/policy.ts", lines: "3" });
  });

  test("a job that keeps failing waits longer each time and then is dead, and a held claim expires", async () => {
    await createWorker(portsWith(embedder)).drain();
    const down = { ...embedder, embed: () => Promise.reject(new Error("the model is down")) };
    const failures: boolean[] = [];
    const worker = createWorker(portsWith(down), {
      onFailure: (job, _error, dead) => failures.push(job.kind === "embed" && dead),
    });
    const before = await w.store.jobs.counts();
    // The write could not embed the fact, so it left that to a job, beside the look for duplicates.
    await publish("The gateway times out after three seconds", "a.ts:1", callsOn(portsWith(down)));
    expect(await worker.drain()).toBe(2);
    expect(await worker.drain()).toBe(0);
    for (const wait of [10_000, 20_000, 40_000, 80_000]) {
      clock.advance(wait - 1);
      expect(await worker.drain()).toBe(0);
      clock.advance(1);
      expect(await worker.drain()).toBe(1);
    }
    expect(failures).toEqual([false, false, false, false, true]);
    expect((await w.store.jobs.counts()).dead).toBe(before.dead + 1);
    clock.advance(3_600_000);
    expect(await worker.drain()).toBe(0);

    await publish("Dunning retries a declined card on days one, three and five");
    const held = await w.store.jobs.claim(clock.now(), 60_000, 5);
    expect(held).toHaveLength(1);
    expect(await worker.drain()).toBe(0);
    clock.advance(60_001);
    expect(await worker.drain()).toBe(1);
  });

  test("a session's note is cut to its beginning after the scan, so a secret across the cut goes whole", async () => {
    const text = `${"word ".repeat(798)}${SECRET} is the deploy token. ${"word ".repeat(2_000)}`;
    const noted = await w.app.noteSession(w.owner, conversation("c-cut"), text);
    const kept = noted?.note?.text ?? "";
    expect(kept).toHaveLength(LIMITS.closing_note_chars);
    expect(kept.slice(3_990)).toBe("[redacted:");
    const stored = await w.store.sessions.latest(w.owner.orgId, w.owner.principalId, PROJECT);
    expect(stored?.note).toEqual({ text: kept, final: false, at: clock.now() });
  });

  test("of a message longer than is read, nothing is kept that could be the beginning of a secret cut where the reading stops", async () => {
    const read = 16 * LIMITS.closing_note_chars;
    // Read whole, a long message keeps its beginning.
    const long = await w.app.noteSession(w.owner, conversation("c-long"), "word ".repeat(30_000));
    expect(long?.note?.text).toBe("word ".repeat(800).trim());

    // A key the scanner replaces with a few characters, then a token that the end of the reading
    // cuts in two: what is left of the token is no rule's to find, and the scan has brought it
    // to the front.
    const key = `-----BEGIN RSA PRIVATE KEY-----\n${"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(1_900)}\n-----END RSA PRIVATE KEY-----\n`;
    const head = `${key}${"word ".repeat(1_000)}`.slice(0, read - 25);
    const cut = `${head}${SECRET} is the deploy token. ${"word ".repeat(2_000)}`;
    const noted = await w.app.noteSession(w.owner, conversation("c-key"), cut);
    expect(noted?.note?.text ?? "").not.toContain("ghp_");
  });
});
