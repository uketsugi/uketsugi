/**
 * What the model step may spend, and when it leaves a session alone: a ceiling on what one
 * session's readings cost, a budget for the day after which readings wait, no paying twice for a
 * retry, and a turn that has no answer yet neither read nor deleted.
 */
import { LIMITS } from "@uketsugi/contracts";
import { ModelError, SESSION_IDLE_MS } from "@uketsugi/core";
import type { FakeRunner } from "@uketsugi/testkit";
import { expect, test } from "vitest";
import { FOUND, scripted, serverWith } from "./digest-world.ts";
import { describeUseCases } from "./use-case-world.ts";

/** A model whose count is four characters to the token, as an ordinary tokenizer's is, not one to the token. */
function realistic(runner: FakeRunner): FakeRunner {
  const run = runner.run.bind(runner);
  runner.run = async (chore) => {
    const answer = await run(chore);
    return { ...answer, inputTokens: Math.ceil(answer.inputTokens / 4) };
  };
  return runner;
}

describeUseCases("what the model step may spend", (w) => {
  const { clock } = w;
  const day = 24 * 3_600_000;

  test("a session that says a great deal costs no more than a session may, and keeps no more turns than a session holds", async () => {
    const runner = realistic(scripted({}));
    const server = serverWith(w, runner);
    await server.call("search_facts", { query: "how are webhooks retried" });
    // A loop that drives an agent through hundreds of long turns.
    for (let at = 0; at < 150; at += 1) {
      await server.turn({ request: `Turn ${at}: ${"why ".repeat(900)}` });
      await server.turn({ answer: `Answer ${at}: ${"because ".repeat(1900)}` });
    }
    const { orgId, id } = await server.session();
    expect(await w.store.sessions.turns(orgId, id)).toHaveLength(100);
    await server.end("Done.");
    await server.drain();

    const read = await server.session();
    const cost = read.modelTokens.input + read.modelTokens.output;
    expect(cost).toBeLessThanOrEqual(150_000);
    expect(runner.asked.length).toBeLessThan(10);
    expect(server.reports[0]?.unread).toBeGreaterThan(0);
    // What it could not read is dropped with the reading: nothing waits to be read twice.
    expect(await w.store.sessions.turns(orgId, id)).toEqual([]);
  });

  test("a reading that would pass the day's budget waits, keeps what it holds, and is read when there is room", async () => {
    const runner = scripted({});
    const server = serverWith(w, runner);
    await server.call("search_facts", { query: "how are webhooks retried" });
    const { orgId, id } = await server.session();
    await server.turn({ request: "Why do webhooks arrive twice?" });
    await server.turn({ answer: FOUND });
    const used = await w.store.sessions.spentSince(new Date(clock.now().getTime() - day));
    runner.dailyTokens = used + 100;
    await server.end(FOUND);
    await server.drain();

    expect(runner.asked).toEqual([]);
    expect(server.reports).toEqual([expect.objectContaining({ waited: true, read: 0 })]);
    expect(await w.store.sessions.turns(orgId, id)).toHaveLength(1);
    // It looks again, and waits again, without asking anything.
    clock.advance(SESSION_IDLE_MS);
    await server.drain();
    expect(runner.asked).toEqual([]);
    expect(await w.store.jobs.counts()).toEqual({ waiting: 1, dead: 0 });

    // A day later what was spent has left the window, and the reading goes through.
    runner.dailyTokens = used + 100_000;
    clock.advance(day);
    await server.drain();
    expect(runner.askedFor("digest.extract")).toHaveLength(1);
    expect(await w.store.sessions.turns(orgId, id)).toEqual([]);
    expect(await w.store.jobs.counts()).toEqual({ waiting: 0, dead: 0 });
  });

  test("a reading that failed after it had cost something is not asked again", async () => {
    const down = new ModelError("the provider refused the call (status 503): overloaded", true);
    let calls = 0;
    const runner = scripted({ extract: () => (++calls === 1 ? { facts: [] } : down) });
    const server = serverWith(w, runner);
    await server.call("search_facts", { query: "how are webhooks retried" });
    const { orgId, id } = await server.session();
    // Enough to be two pieces: the first is asked and paid for, the second fails.
    for (let at = 0; at < 6; at += 1) {
      await w.store.sessions.addTurn(orgId, id, {
        id: w.ids.uuid(),
        request: null,
        answer: `${FOUND} ${"x".repeat(LIMITS.turn_answer_chars - FOUND.length - 1)}`,
        at: clock.now(),
      });
    }
    await server.end(FOUND);
    await server.drain();
    clock.advance(day);
    await server.drain();

    expect(runner.askedFor("digest.extract")).toHaveLength(2);
    expect(server.failures).toEqual([expect.objectContaining({ retryable: false })]);
    expect((await server.session()).modelTokens.input).toBeGreaterThan(0);
    expect(await w.store.sessions.turns(orgId, id)).toEqual([]);
    expect(await w.store.jobs.counts()).toEqual({ waiting: 0, dead: 1 });
  });
});

describeUseCases("a reading whose session is gone", (w) => {
  test("is nothing to do: it is retired without a call or a failure", async () => {
    const runner = scripted({});
    const server = serverWith(w, runner);
    await w.store.jobs.armDigest(w.owner.orgId, w.ids.uuid(), w.clock.now());
    await server.drain();
    expect(runner.asked).toEqual([]);
    expect(server.failures).toEqual([]);
    expect(await w.store.jobs.counts()).toEqual({ waiting: 0, dead: 0 });
  });
});

describeUseCases("a session that is still working", (w) => {
  const { clock } = w;

  test("a turn with no answer yet is neither read nor deleted, and the answer is read with its request", async () => {
    const runner = scripted({});
    const server = serverWith(w, runner);
    await server.call("search_facts", { query: "how are webhooks retried" });
    const { orgId, id } = await server.session();
    await server.turn({ request: "FIRST question" });
    await server.turn({ answer: `FIRST answer. ${FOUND}` });
    await server.turn({ request: "SECOND question" });
    // The second turn runs for longer than the quiet minutes that arm a reading.
    clock.advance(SESSION_IDLE_MS + 1000);
    await server.drain();

    const [first] = runner.askedFor("digest.extract");
    expect(first?.material).toContain("FIRST");
    expect(first?.material).not.toContain("SECOND");
    expect(await w.store.sessions.turns(orgId, id)).toEqual([
      expect.objectContaining({ request: "SECOND question", answer: null }),
    ]);

    await server.turn({ answer: `SECOND answer. ${FOUND}` });
    clock.advance(SESSION_IDLE_MS + 1000);
    await server.drain();
    const [, second] = runner.askedFor("digest.extract");
    const said = (
      JSON.parse(second?.material ?? "") as { said: { request: string; answer: string }[] }
    ).said;
    expect(said.map((each) => each.request)).toEqual(["SECOND question"]);
    expect(said[0]?.answer).toContain("SECOND answer");
    expect(await w.store.sessions.turns(orgId, id)).toEqual([]);
  });

  test("another window opening in the project does not hasten a session that has a turn running", async () => {
    const runner = scripted({});
    const server = serverWith(w, runner);
    await server.call("search_facts", { query: "how are webhooks retried" });
    clock.advance(9 * 60_000);
    await server.turn({ request: "A long question" });
    // Past the idle gap since its last call, but its turn is still going and its reading not due.
    clock.advance(2 * 60_000);
    const working = await server.session();
    await server.another("search_facts", { query: "something else" });
    await server.drain();
    expect((await w.store.sessions.byIds(working.orgId, [working.id]))[0]?.digestedAt).toBeNull();
  });
});
