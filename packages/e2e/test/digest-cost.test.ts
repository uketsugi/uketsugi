/**
 * What the model step may spend, and when it leaves a session alone: a ceiling on what one
 * session's readings cost, a budget for the day after which readings wait, no paying twice for a
 * retry, and a turn that has no answer yet neither read nor deleted.
 */
import { RESERVE_TOKENS, SESSION_IDLE_MS, SESSION_TOKENS } from "@uketsugi/core";
import type { FakeRunner } from "@uketsugi/testkit";
import { expect, test } from "vitest";
import { candidate, FOUND, scripted, serverWith } from "./digest-world.ts";
import { describeUseCases } from "./use-case-world.ts";

/** A model whose count is `share` of what the fake counts, which is one token to the character. */
function counting(runner: FakeRunner, share: number): FakeRunner {
  const run = runner.run.bind(runner);
  runner.run = async (chore) => {
    const answer = await run(chore);
    return { ...answer, inputTokens: Math.ceil(answer.inputTokens * share) };
  };
  return runner;
}

/** A model whose count is four characters to the token, as an ordinary tokenizer's is, not one to the token. */
const realistic = (runner: FakeRunner): FakeRunner => counting(runner, 1 / 4);

/**
 * A model that counts each call by `count`, and says what every call took in and gave out as it
 * went, so a test can see how far a reading went before it stopped.
 */
function metered(
  runner: FakeRunner,
  count: (chars: number) => { input: number; output: number },
): { runner: FakeRunner; calls: { step: string; total: number }[] } {
  const calls: { step: string; total: number }[] = [];
  const run = runner.run.bind(runner);
  let total = 0;
  runner.run = async (chore) => {
    const answer = await run(chore);
    const counted = count(chore.instructions.length + chore.material.length);
    total += counted.input + counted.output;
    calls.push({ step: chore.step, total });
    return { ...answer, inputTokens: counted.input, outputTokens: counted.output };
  };
  return { runner, calls };
}

/** What the server estimates a chore of this many characters may cost, before the call. */
const estimate = (chars: number): number => Math.ceil(chars / 3) + 2_000;

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
    expect(server.reports[0]?.unread).toBeGreaterThan(0);
    // What it could not read is dropped with the reading: nothing waits to be read twice.
    expect(await w.store.sessions.turns(orgId, id)).toEqual([]);
  });

  test("a session is read until what the provider counted reaches its limit, not until the estimate does", async () => {
    // The server estimates three characters to a token; this provider counts nine, a third as many.
    const runner = counting(scripted({}), 1 / 9);
    const server = serverWith(w, runner);
    await server.call("search_facts", { query: "how are webhooks retried" });
    for (let at = 0; at < 100; at += 1) {
      await server.turn({ request: `Turn ${at}: ${"why ".repeat(1000)}` });
      await server.turn({ answer: `Answer ${at}: ${"because ".repeat(2000)}` });
    }
    await server.end("Done.");
    await server.drain();

    const read = await server.session();
    const cost = read.modelTokens.input + read.modelTokens.output;
    const [report] = server.reports;
    // By the estimate 16 of the 100 turns fit; by the provider's count, about three times as many.
    expect(report?.read).toBeGreaterThanOrEqual(48);
    expect(report?.read).toBeLessThan(100);
    expect(report?.unread).toBe(100 - (report?.read ?? 0));
    // The next piece would have passed the limit, and no piece did.
    expect(cost).toBeLessThanOrEqual(SESSION_TOKENS);
    expect(cost).toBeGreaterThan(SESSION_TOKENS - 40_000);
  });

  /** A session of `turns` turns that each say `chars` characters, ended and read. */
  async function readSession(runner: FakeRunner, turns: number, chars: number) {
    const server = serverWith(w, runner);
    await server.call("search_facts", { query: "how are webhooks retried" });
    for (let at = 0; at < turns; at += 1) {
      await server.turn({ request: "q" });
      await server.turn({ answer: `Answer ${at}: ${"b".repeat(chars)}` });
    }
    await server.end("Done.");
    await server.drain();
    return server;
  }

  test("a call whose real cost is the estimate is not asked when it would pass the limit", async () => {
    // Provider counts what the server estimates, less its slack: pieces of 16,800 tokens, 8 of which are 134,400.
    const { runner, calls } = metered(scripted({}), (chars) => ({
      input: estimate(chars) - 2_000,
      output: 10,
    }));
    await readSession(runner, 90, 15_900);
    const asked = calls.filter((call) => call.step === "digest.extract");
    expect(asked.length).toBeGreaterThan(5);
    expect(calls.at(-1)?.total).toBeLessThanOrEqual(SESSION_TOKENS);
  });

  test("what the closing questions need is kept back from the readings", async () => {
    const { runner, calls } = metered(scripted({}), (chars) => ({
      input: estimate(chars) - 2_000,
      output: 10,
    }));
    await readSession(runner, 90, 15_400);
    const reads = calls.filter((call) => call.step === "digest.extract");
    expect(reads.length).toBeGreaterThan(5);
    expect(reads.at(-1)?.total).toBeLessThanOrEqual(SESSION_TOKENS - RESERVE_TOKENS);
  });

  test("a provider that counts nothing is counted by the estimate, and a session stays within its limit", async () => {
    const { runner, calls } = metered(scripted({}), () => ({ input: 0, output: 0 }));
    const server = await readSession(runner, 90, 15_900);
    const read = await server.session();
    expect(read.modelTokens.input + read.modelTokens.output).toBeLessThanOrEqual(SESSION_TOKENS);
    expect(calls.filter((call) => call.step === "digest.extract").length).toBeLessThan(10);
    expect(server.reports[0]?.unread).toBeGreaterThan(0);
  });

  test("a provider that counts the input and not the answer is counted for the answer by the estimate", async () => {
    const { runner } = metered(scripted({}), (chars) => ({
      input: Math.ceil(chars / 9),
      output: 0,
    }));
    const server = await readSession(runner, 90, 15_900);
    // 2,000 for each answer is far more than the real 10: the stand-in is what holds the count up.
    expect((await server.session()).modelTokens.output).toBeGreaterThanOrEqual(2_000 * 3);
  });

  test("a reading that reaches the day's budget part-way keeps the turns it did not read, and reads them when there is room", async () => {
    // The provider counts twice what the server estimates, so the plan that fitted the day does not.
    const dense = (chars: number) => ({ input: Math.ceil(chars / 3) * 2, output: 10 });
    const { runner } = metered(scripted({}), dense);
    // Four pieces of three turns; the whole plan by the estimate, with the reserve, is the day.
    const used = await w.store.sessions.spentSince(new Date(clock.now().getTime() - day));
    runner.dailyTokens = used + 4 * (estimate(47_700) + 2_000) + RESERVE_TOKENS + 6_000;
    const server = serverWith(w, runner);
    await server.call("search_facts", { query: "how are webhooks retried" });
    const { orgId, id } = await server.session();
    for (let at = 0; at < 12; at += 1) {
      await server.turn({ request: "q" });
      await server.turn({ answer: `Answer ${at}: ${"b".repeat(15_900)}` });
    }
    await server.end("Done.");
    await server.drain();

    const [first] = server.reports;
    expect(first).toMatchObject({ waited: false, unread: 0 });
    expect(first?.read).toBeGreaterThan(0);
    expect(first?.read).toBeLessThan(12);
    expect(first?.kept).toBe(12 - (first?.read ?? 0));
    expect(await w.store.sessions.turns(orgId, id)).toHaveLength(first?.kept ?? 0);
    expect(await w.store.jobs.counts()).toMatchObject({ waiting: 1, dead: 0 });

    // The day that spent it has gone: the rest is read, and none of it twice.
    runner.dailyTokens = Number.MAX_SAFE_INTEGER;
    clock.advance(day + 1);
    await server.drain();
    const answers = runner
      .askedFor("digest.extract")
      .flatMap((chore) => (JSON.parse(chore.material) as { said: { answer: string }[] }).said)
      .map((each) => each.answer.slice(0, 12));
    expect(answers).toHaveLength(12);
    expect(new Set(answers).size).toBe(12);
    expect(await w.store.sessions.turns(orgId, id)).toEqual([]);
  });

  test("a reading the day's budget stops before its first piece waits whole, and nothing of the session is stamped read", async () => {
    // What the piece costs by the estimate, read from the same words in another session.
    const measuring = scripted({});
    await readSession(measuring, 1, 15_900);
    const [piece] = measuring.askedFor("digest.extract");
    const cost = estimate((piece?.instructions.length ?? 0) + (piece?.material.length ?? 0));

    const runner = scripted({});
    const server = serverWith(w, runner);
    await server.call("search_facts", { query: "how are webhooks retried" });
    const { orgId, id } = await server.session();
    await server.turn({ request: "q" });
    await server.turn({ answer: `Answer 0: ${"b".repeat(15_900)}` });
    // Room in the session for the piece but not for the estimate's whole reading, which then
    // plans no piece and passes the day's check; the day then has room for no piece at all.
    const spent = SESSION_TOKENS - (cost + RESERVE_TOKENS + 1_000);
    await w.store.sessions.spent(orgId, id, { input: spent, output: 0 }, clock.now());
    const used = await w.store.sessions.spentSince(new Date(clock.now().getTime() - day));
    runner.dailyTokens = used + RESERVE_TOKENS + 500;
    await server.end("Done.");
    await server.drain();

    expect(server.reports).toEqual([expect.objectContaining({ waited: true, read: 0 })]);
    expect(runner.asked).toEqual([]);
    expect((await server.session()).digestedAt).toBeNull();
    expect(await w.store.sessions.turns(orgId, id)).toHaveLength(1);

    // A day later the reading goes through, whole.
    runner.dailyTokens = Number.MAX_SAFE_INTEGER;
    clock.advance(day + 1);
    await server.drain();
    expect(runner.askedFor("digest.extract")).toHaveLength(1);
    expect(await w.store.sessions.turns(orgId, id)).toEqual([]);
  });

  test("a citation is held against what the model was sent: not against turns it was never shown, nor another piece's", async () => {
    let calls = 0;
    const runner = counting(
      scripted({
        extract: () =>
          ++calls === 2
            ? {
                facts: [
                  candidate("The cache is in the unread file", ["src/n99.ts:7-9"]),
                  candidate("The first piece's file is shown only to the first", ["src/n0.ts:7-9"]),
                  candidate("The second piece's own file is cited", ["src/n3.ts:7-9"]),
                ],
              }
            : { facts: [] },
      }),
      1 / 9,
    );
    const server = serverWith(w, runner);
    await server.call("search_facts", { query: "how are webhooks retried" });
    for (let at = 0; at < 100; at += 1) {
      await server.turn({ request: "q" });
      await server.turn({
        answer: `Answer ${at}: see src/n${at}.ts:7-9 ${"because ".repeat(2000)}`,
      });
    }
    await server.end("Done.");
    await server.drain();

    const [report] = server.reports;
    expect(report?.unread).toBeGreaterThan(0);
    // Only the file the second piece shows is kept, with its lines; the other two have no source.
    expect(report).toMatchObject({ written: 1, refused: { uncited: 2 } });
    const found = await server.call("search_facts", { query: "second piece own file cited" });
    expect(found.facts[0]?.citations).toEqual([
      { ref: "src/n3.ts:7-9", kind: "file", class: "checkable" },
    ]);
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
    expect(await w.store.jobs.counts()).toMatchObject({ waiting: 1, dead: 0 });

    // A day later what was spent has left the window, and the reading goes through.
    runner.dailyTokens = used + 100_000;
    clock.advance(day);
    await server.drain();
    expect(runner.askedFor("digest.extract")).toHaveLength(1);
    expect(await w.store.sessions.turns(orgId, id)).toEqual([]);
    expect(await w.store.jobs.counts()).toMatchObject({ waiting: 0, dead: 0 });
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
    expect(await w.store.jobs.counts()).toMatchObject({ waiting: 0, dead: 0 });
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
