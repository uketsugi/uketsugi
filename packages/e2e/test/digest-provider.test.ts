/** What a provider's failure does to a reading: it waits, loses nothing it need not, and is given up after twelve hours. */
import { LIMITS } from "@uketsugi/contracts";
import { ModelError, WAIT_MS } from "@uketsugi/core";
import { expect, test } from "vitest";
import { candidate, FOUND, scripted, serverWith } from "./digest-world.ts";
import { describeUseCases } from "./use-case-world.ts";

describeUseCases("a model provider that fails", (w) => {
  const { clock } = w;
  const day = 24 * 3_600_000;

  /** A session of six full turns, which a reading takes in more than one piece: the first piece is asked and paid for. */
  async function sessionOfSixTurns(server: ReturnType<typeof serverWith>) {
    await server.call("search_facts", { query: "how are webhooks retried" });
    const { orgId, id } = await server.session();
    for (let at = 0; at < 6; at += 1) {
      await w.store.sessions.addTurn(orgId, id, {
        id: w.ids.uuid(),
        request: null,
        answer: `${FOUND} ${"x".repeat(LIMITS.turn_answer_chars - FOUND.length - 1)}`,
        at: clock.now(),
      });
    }
    await server.end(FOUND);
    return { orgId, id };
  }

  /** The session a case's reading is about: `server.session()` is the latest, which a later call may have begun. */
  const sessionOf = async (orgId: string, id: string) => {
    const [session] = await w.store.sessions.byIds(orgId, [id]);
    if (session === undefined) throw new Error("the session is gone");
    return session;
  };

  const FACT = candidate(
    "The webhook queue retries a failed delivery five times, capped at 30 seconds",
    ["src/queue/retry.ts:40-62"],
  );
  const down = new ModelError("the provider refused the call (status 503): overloaded", true);

  test("a reading that fails after it has cost keeps the facts it drew, deletes the turns it read, and leaves the rest to wait", async () => {
    let outage = false;
    let calls = 0;
    const runner = scripted({
      extract: () => (++calls === 1 ? { facts: [FACT] } : outage ? down : { facts: [] }),
    });
    const server = serverWith(w, runner);
    const { orgId, id } = await sessionOfSixTurns(server);
    const before = (await w.store.sessions.turns(orgId, id)).length;
    outage = true;
    await server.drain();

    expect(runner.askedFor("digest.extract")).toHaveLength(2);
    // The provider's failure is not the job's: nothing is dead, and what it read is not sent again.
    expect(server.failures).toEqual([]);
    const left = (await w.store.sessions.turns(orgId, id)).length;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(before);
    expect(server.reports).toEqual([
      expect.objectContaining({ kept: left, failure: down.message, written: 1 }),
    ]);
    const found = await server.call("search_facts", { query: "webhook queue retries" });
    expect(found.facts.map((fact: { claim: string }) => fact.claim)).toContain(FACT.claim);
    expect(await sessionOf(orgId, id)).toMatchObject({
      digestFailure: { reason: down.message },
    });
    expect(await w.store.jobs.counts()).toMatchObject({ waiting: 1, dead: 0 });

    // When the provider answers, the turns that waited are read, once.
    outage = false;
    clock.advance(WAIT_MS);
    await server.drain();
    expect(await w.store.sessions.turns(orgId, id)).toEqual([]);
    expect(await sessionOf(orgId, id)).toMatchObject({ digestFailure: null });
    expect(await w.store.jobs.counts()).toMatchObject({ waiting: 0, dead: 0 });
  });

  test("a failure that leaves nothing waiting does not make a later reading be given up", async () => {
    // The choice of the brief's facts is the last question: it fails after everything was read.
    let outage = true;
    const runner = scripted({
      extract: () => ({ facts: [FACT] }),
      choose: () => (outage ? down : { show: [] }),
    });
    const server = serverWith(w, runner);
    for (let n = 1; n <= 30; n += 1) {
      const claim = `Subsystem number ${n} keeps its settings in a file of its own and reloads them when the file changes, which takes effect on the next request and not before it`;
      await server.call("publish_fact", { claim, citations: `config/part-${n}.toml:1` });
    }
    const { orgId, id } = await sessionOfSixTurns(server);
    await server.drain();
    expect(runner.askedFor("digest.choose")).toHaveLength(1);
    expect(await w.store.sessions.turns(orgId, id)).toEqual([]);
    expect(await w.store.jobs.counts()).toMatchObject({ waiting: 0, dead: 0 });
    // The failure left nothing unread, so nothing of it is kept to be told of.
    expect((await sessionOf(orgId, id)).digestFailure).toBeNull();

    // A day later the session says more. What it says is read, and nothing is given up.
    outage = false;
    clock.advance(day);
    await w.store.sessions.addTurn(orgId, id, {
      id: w.ids.uuid(),
      request: null,
      answer: FOUND,
      at: clock.now(),
    });
    await w.store.jobs.armDigest(orgId, id, clock.now());
    await server.drain();
    expect(server.failures).toEqual([]);
    expect(await w.store.sessions.turns(orgId, id)).toEqual([]);
    expect(await w.store.jobs.counts()).toMatchObject({ waiting: 0, dead: 0 });
    expect((await sessionOf(orgId, id)).digestFailure).toBeNull();
  });

  test.each([
    ["an outage", down],
    [
      "a key or an account the provider refuses",
      new ModelError("the provider refused the call (status 402): credit is spent", false),
    ],
  ])(
    "%s before the reading has cost anything makes the whole session wait, with its turns",
    async (_name, refusal) => {
      let outage = true;
      const runner = scripted({ extract: () => (outage ? refusal : { facts: [] }) });
      const server = serverWith(w, runner);
      const { orgId, id } = await sessionOfSixTurns(server);
      const before = (await w.store.sessions.turns(orgId, id)).length;
      await server.drain();

      expect(server.failures).toEqual([]);
      expect(server.reports).toEqual([
        expect.objectContaining({ waited: true, failure: refusal.message }),
      ]);
      expect(await w.store.sessions.turns(orgId, id)).toHaveLength(before);
      expect(await w.store.jobs.counts()).toMatchObject({ waiting: 1, dead: 0 });
      outage = false;
      clock.advance(WAIT_MS);
      await server.drain();
      expect(await w.store.sessions.turns(orgId, id)).toEqual([]);
      expect(await w.store.jobs.counts()).toMatchObject({ waiting: 0, dead: 0 });
    },
  );

  test("what waits on a provider that keeps failing is dropped after twelve hours, and the reading is given up", async () => {
    const runner = scripted({ extract: () => down });
    const server = serverWith(w, runner);
    const { orgId, id } = await sessionOfSixTurns(server);
    const hour = 3_600_000;
    await server.drain();
    clock.advance(11 * hour);
    await server.drain();
    // Eleven hours on, still waiting: its turns are held, and the first failure's time is kept.
    expect(await w.store.sessions.turns(orgId, id)).not.toEqual([]);
    expect(await w.store.jobs.counts()).toMatchObject({ waiting: 1, dead: 0 });
    clock.advance(hour + WAIT_MS);
    await server.drain();
    expect(await w.store.sessions.turns(orgId, id)).toEqual([]);
    expect(await w.store.jobs.counts()).toMatchObject({ waiting: 0, dead: 1 });
    expect(server.failures.map(String)).toEqual([expect.stringContaining("twelve hours")]);
  });
});
