/**
 * The model step on a real store, with a scripted model: when a session is read, what is read of
 * it, what a reading costs, what a failure leaves, and the choice of the next brief's facts.
 */
import { LIMITS } from "@uketsugi/contracts";
import { activityReport, ModelError, SESSION_IDLE_MS, type ModelRunner } from "@uketsugi/core";
import { expect, test, vi } from "vitest";
import { candidate, FOUND, scripted, serverWith } from "./digest-world.ts";
import { describeUseCases } from "./use-case-world.ts";

describeUseCases("when and what the model step reads", (w) => {
  const { clock } = w;

  test("turns a hook sent are what the model reads, each once, and they are deleted when read", async () => {
    const runner = scripted({
      extract: ({ said }) => ({
        facts:
          said.length === 2 ? [candidate("Retries live in the queue", ["src/queue/retry.ts"])] : [],
      }),
    });
    const server = serverWith(w, runner);
    await server.call("search_facts", { query: "how are webhooks retried" });
    const { orgId, id } = await server.session();
    const turns = [
      {
        id: w.ids.uuid(),
        request: "Why do webhooks arrive twice?",
        answer: FOUND,
        at: clock.now(),
      },
      { id: w.ids.uuid(), request: "And the cap?", answer: "It is 30 seconds.", at: clock.now() },
    ];
    for (const turn of turns) await w.store.sessions.addTurn(orgId, id, turn);
    await server.end("It is 30 seconds.");
    await server.drain();

    const [first] = runner.askedFor("digest.extract");
    // A turn travels as what was asked and what was answered, and nothing else of its row.
    expect(JSON.parse(first?.material ?? "")).toEqual({
      said: turns.map(({ request, answer }) => ({ request, answer })),
      recorded: [],
    });
    expect(server.reports).toEqual([expect.objectContaining({ read: 2, written: 1 })]);
    expect(await w.store.sessions.turns(orgId, id)).toEqual([]);
    expect(await w.store.jobs.counts()).toEqual({ waiting: 0, dead: 0 });
    const read = await server.session();
    expect(read.digestedAt).not.toBeNull();
    // What a reading cost is kept with its session, and Activity shows it.
    expect(read.modelTokens.input).toBeGreaterThan(FOUND.length);
    expect(read.modelTokens.output).toBe(10);
    expect(server.reports[0]?.tokens).toEqual(read.modelTokens);
    const { recent } = await activityReport(server.ports, w.owner, { days: 1 });
    expect(recent[0]?.digest).toEqual({
      at: read.digestedAt?.toISOString(),
      input_tokens: read.modelTokens.input,
      output_tokens: read.modelTokens.output,
    });
  });

  test("a turn is kept scanned and cut, each side to its own length, and only where a model will read it", async () => {
    const secret = `ghp_${"16C7e42F292c6912E7710c838347Ae178B4a"}`;
    const server = serverWith(w, scripted({}));
    await server.call("search_facts", { query: "how are webhooks retried" });
    const { orgId, id } = await server.session();
    expect(
      await server.turn({ request: `Use ${secret} to deploy. ${"word ".repeat(2_000)}` }),
    ).toBe(true);
    expect(await server.turn({ answer: `Done. ${"word ".repeat(8_000)}` })).toBe(true);
    expect(await server.turn({ answer: "   " })).toBe(false);
    const [kept, ...rest] = await w.store.sessions.turns(orgId, id);
    expect(rest).toEqual([]);
    expect(kept?.request).toHaveLength(LIMITS.turn_request_chars);
    expect(kept?.request?.startsWith("Use [redacted:github-token] to deploy.")).toBe(true);
    expect(kept?.answer?.length).toBeLessThanOrEqual(LIMITS.turn_answer_chars);
    expect(kept?.answer?.length).toBeGreaterThan(LIMITS.turn_answer_chars - 10);
    // The session ends and is read: nothing of it waits when the next case begins.
    await server.end("Done.");
    await server.drain();
    expect(await w.store.sessions.turns(orgId, id)).toEqual([]);

    // A server with no model keeps nothing of a turn: nothing would ever read it.
    const plain = serverWith(w, undefined);
    await plain.call("search_facts", { query: "how are webhooks retried" });
    expect(await plain.turn({ request: "Why do webhooks arrive twice?" })).toBe(false);
    expect(await plain.turn({ answer: FOUND })).toBe(false);
    const unread = await plain.session();
    expect(await w.store.sessions.turns(unread.orgId, unread.id)).toEqual([]);
  });

  test("a session that never says it is over is read once it has been quiet, or when its person starts the next one", async () => {
    const runner = scripted({});
    const server = serverWith(w, runner);
    await server.call("search_facts", { query: "how are webhooks retried" });
    await server.note(FOUND);
    await server.drain();
    expect(runner.asked).toEqual([]);
    clock.advance(SESSION_IDLE_MS - 1000);
    // What it says later puts the reading off again: it is not over yet.
    await server.note(`${FOUND} And the cap is 30 seconds.`);
    clock.advance(SESSION_IDLE_MS - 1000);
    await server.drain();
    expect(runner.asked).toEqual([]);
    clock.advance(1000);
    await server.drain();
    expect(runner.askedFor("digest.extract")).toHaveLength(1);

    // A session that is killed leaves a note and no word that it ended. The session that follows
    // it in the project is the one that needs what it found, so it is read as that one begins:
    // its last turn was answered, so nothing of it is still running.
    const killed = serverWith(w, runner);
    await killed.call("search_facts", { query: "how are webhooks retried" });
    await killed.note(FOUND);
    await killed.another("search_facts", { query: "what did the last session find" });
    await killed.drain();
    expect(runner.askedFor("digest.extract")).toHaveLength(2);
    // It is not read a second time once it has been quiet.
    clock.advance(SESSION_IDLE_MS);
    await killed.drain();
    expect(runner.askedFor("digest.extract")).toHaveLength(2);
  });

  test("a conversation that goes on under a new session, after a long quiet, does not have its earlier part read early", async () => {
    const runner = scripted({});
    const server = serverWith(w, runner);
    await server.call("search_facts", { query: "how are webhooks retried" });
    const earlier = await server.session();
    clock.advance(5 * 60_000);
    await server.note(FOUND);
    // Eleven minutes after its last call the conversation calls again: a new session, the same conversation.
    clock.advance(6 * 60_000);
    await server.call("search_facts", { query: "what is the retry cap" });
    expect((await server.session()).id).not.toBe(earlier.id);
    await server.drain();
    expect(runner.asked).toEqual([]);
    // Its earlier part is read when that part has been quiet for its ten minutes.
    clock.advance(4 * 60_000);
    await server.drain();
    expect(runner.askedFor("digest.extract")).toHaveLength(1);
  });

  test("a reading that fails is tried again later, counts what it spent, and is given up with what it could not read", async () => {
    let fails = 2;
    const down = new ModelError("the provider refused the call (status 503): overloaded", true);
    const runner = scripted({
      extract: () => (fails-- > 0 ? down : { facts: [] }),
    });
    const server = serverWith(w, runner);
    await server.end(FOUND);
    await server.drain();
    expect(server.failures).toEqual([down]);
    expect(server.reports).toEqual([]);
    await server.drain();
    expect(runner.asked).toHaveLength(1);
    clock.advance(10_000);
    await server.drain();
    clock.advance(20_000);
    await server.drain();
    expect(runner.asked).toHaveLength(3);
    expect(server.reports).toEqual([expect.objectContaining({ read: 1, written: 0 })]);

    // An answer that is not one is not asked for again: the reading is given up at once, and the
    // turns it could not read go with it. What the asking cost is still counted.
    const garbled = scripted({ extract: () => ({ answer: "Sure! Here are the facts." }) });
    const other = serverWith(w, garbled);
    await other.call("search_facts", { query: "how are webhooks retried" });
    const { orgId, id } = await other.session();
    await w.store.sessions.addTurn(orgId, id, {
      id: w.ids.uuid(),
      request: null,
      answer: FOUND,
      at: clock.now(),
    });
    await other.end(FOUND);
    await other.drain();
    clock.advance(3_600_000);
    await other.drain();
    expect(garbled.asked).toHaveLength(1);
    expect(other.failures).toEqual([expect.objectContaining({ retryable: false })]);
    expect(await w.store.sessions.turns(orgId, id)).toEqual([]);
    expect(await other.session()).toMatchObject({
      digestedAt: null,
      modelTokens: { output: 10 },
    });
    expect((await w.store.jobs.counts()).waiting).toBe(0);
  });

  test("a server that stops gives up the question in flight, and the session is read when it is back", async () => {
    const asked: AbortSignal[] = [];
    const slow: ModelRunner = {
      kind: "endpoint",
      name: "slow · never answers",
      dailyTokens: Number.MAX_SAFE_INTEGER,
      serves: () => true,
      run: (_chore, signal = new AbortController().signal) => {
        asked.push(signal);
        const gaveUp = new ModelError("the model did not answer in time", true);
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(gaveUp), { once: true }),
        );
      },
    };
    const server = serverWith(w, slow);
    await server.end(FOUND);
    const reading = server.drain();
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    await server.stop();
    await reading;
    expect(asked[0]?.aborted).toBe(true);
    // Not a failure: nothing is logged, nothing is lost, and the reading is due at once.
    expect(server.failures).toEqual([]);
    expect(await server.session()).toMatchObject({ digestedAt: null });
    expect((await w.store.jobs.counts()).waiting).toBe(1);

    const back = serverWith(w, scripted({}));
    await back.drain();
    expect((await server.session()).digestedAt).not.toBeNull();
    expect((await w.store.jobs.counts()).waiting).toBe(0);
  });

  test("where a project holds more than a brief shows, a model chooses what the next brief leads with", async () => {
    const chosen: string[] = [];
    const runner = scripted({
      choose: ({ stopped, facts }) => {
        expect(stopped).toContain("exponential backoff");
        const wanted = facts.filter((fact) => /number (7|31) /.test(fact.claim));
        chosen.push(...wanted.map((fact) => fact.claim));
        return { show: wanted.map((fact) => fact.n).reverse() };
      },
    });
    const server = serverWith(w, runner);
    for (let n = 1; n <= 40; n += 1) {
      const about = `Subsystem number ${n} keeps its settings in a file of its own and reloads them when the file changes`;
      await server.call("publish_fact", { claim: about, citations: `config/part-${n}.toml:1` });
      clock.advance(1000);
    }
    await server.end(FOUND);
    await server.drain();
    expect(server.reports.at(-1)).toMatchObject({ chose: true });
    expect(chosen).toHaveLength(2);

    const brief = (await server.call("search_facts", { query: "settings file" })).brief;
    expect(brief?.fact_count).toBe(40);
    expect(brief?.facts.length).toBeLessThan(40);
    // The pool reaches the model newest first, and the script reverses its two: its order is kept.
    expect(brief?.facts.slice(0, 2).map((fact) => fact.claim)).toEqual([
      expect.stringContaining("number 7 "),
      expect.stringContaining("number 31 "),
    ]);
    // The rule orders the rest as before: the newest first.
    expect(brief?.facts[2]?.claim).toContain("number 40 ");

    // A session that said nothing and published nothing costs no call, whatever the project holds.
    await server.call("search_facts", { query: "settings file" });
    await server.end("Nothing to add.");
    await server.drain();
    expect(runner.askedFor("digest.choose")).toHaveLength(1);
    expect(server.reports.at(-1)).toMatchObject({
      read: 0,
      chose: false,
      tokens: { input: 0, output: 0 },
    });

    // A project whose facts all fit is not put to the model.
    const small = serverWith(w, runner);
    await small.call("publish_fact", { claim: "Deploys run from main", citations: "ci.yml:3" });
    await small.end(FOUND);
    await small.drain();
    expect(small.reports.at(-1)).toMatchObject({ chose: false });
    expect(runner.askedFor("digest.choose")).toHaveLength(1);
  });
});
