/**
 * What the model step may spend where the key is the operator's: a limit on each person and one on
 * an organization over its people together. A person over theirs has their next reading wait, in
 * words they read on their dashboard, and the others of their organization go on; the organization's
 * limit holds over what they spend between them. Both are counted over a day.
 */
import {
  activityReport,
  createApp,
  createTokenIdentity,
  createWorker,
  type Caller,
  type CorePorts,
} from "@uketsugi/core";
import { expect, test } from "vitest";
import { candidate, FOUND, scripted } from "./digest-world.ts";
import { sharedWorld } from "./sharing-world.ts";
import { CLIENT, describeUseCases } from "./use-case-world.ts";

/**
 * What one reading of `FOUND` is held to by the estimate: about thirteen thousand tokens with the
 * reserve, and it costs about a thousand when it is made. A limit of this makes room for one.
 */
const ONE_READING = 13_000;

describeUseCases("the model step's limits for a person and an organization", (w) => {
  const s = sharedWorld(w);
  const project = "github.com/acme/digest-limits";
  const day = 24 * 3_600_000;

  /** A model that serves everyone, as a hosted edition's does, and the server it runs on. */
  function hosted() {
    const runner = scripted({
      extract: () => ({ facts: [candidate("Retries live in the queue", ["src/queue/retry.ts"])] }),
    });
    const worker = createWorker({ ...w.portsWith(w.embedder), runner });
    const ports: CorePorts = { ...w.portsWith(w.embedder), runner, store: worker.store };
    const app = createApp({ ...ports, identity: createTokenIdentity(ports) });
    let count = 0;
    return {
      runner,
      ports,
      /** The person's session ends with something to read, in a conversation of its own. */
      async end(who: Caller) {
        count += 1;
        const conversation = { client: CLIENT.name, id: `limits-${count}`, project };
        await app.noteSession(who, conversation, FOUND);
        await app.endSession(who, conversation);
      },
      async drain() {
        while ((await worker.drain()) > 0);
      },
      /** What the person's dashboard says of their newest session's reading. */
      async digestOf(who: Caller) {
        const { recent } = await activityReport(ports, who, { days: 1 });
        return recent[0]?.digest;
      },
    };
  }

  test("a person over their own limit has their next reading wait, in words they can read, while another of their organization is read", async () => {
    const server = hosted();
    server.runner.personDailyTokens = ONE_READING;
    await server.end(s.ann);
    await server.drain();
    expect(await server.digestOf(s.ann)).toMatchObject({ waiting: null });
    expect(server.runner.askedFor("digest.extract")).toHaveLength(1);

    await server.end(s.ann);
    await server.drain();
    expect(server.runner.askedFor("digest.extract")).toHaveLength(1);
    const waits = (await server.digestOf(s.ann))?.waiting;
    expect(waits).toMatch(/^Waiting: your own limit on what the model reads in a day is used up/);
    expect(waits).not.toContain("Bob");

    // Bob has spent nothing, and Ann's spending is none of his: he is read.
    await server.end(s.bob);
    await server.drain();
    expect(server.runner.askedFor("digest.extract")).toHaveLength(2);
    expect(await server.digestOf(s.bob)).toMatchObject({ waiting: null });

    // A day on, Ann's use has left her window: her reading is made and says nothing of waiting.
    w.clock.advance(day + 1);
    await server.drain();
    expect(server.runner.askedFor("digest.extract")).toHaveLength(3);
    expect(await server.digestOf(s.ann)).toMatchObject({ waiting: null });
  });

  test("the organization's limit holds over its people together: what one spends leaves the other less", async () => {
    // What the first case spent has left the day's window.
    w.clock.advance(day + 1);
    const server = hosted();
    server.runner.dailyTokens = ONE_READING;
    await server.end(s.ann);
    await server.drain();
    expect(server.runner.askedFor("digest.extract")).toHaveLength(1);

    await server.end(s.bob);
    await server.drain();
    expect(server.runner.askedFor("digest.extract")).toHaveLength(1);
    expect((await server.digestOf(s.bob))?.waiting).toMatch(
      /^Waiting: the limit for everyone in your organization together on what the model reads in a day is used up/,
    );

    w.clock.advance(day + 1);
    await server.drain();
    expect(server.runner.askedFor("digest.extract")).toHaveLength(2);
    expect(await server.digestOf(s.bob)).toMatchObject({ waiting: null });
  });
});
