/**
 * The model step on a server with several people. What is sent to a provider leaves the machine,
 * and only whoever runs the server agreed to that by configuring a model: nobody else's sessions
 * are read, and nobody else's facts are put to the model, shared or not.
 */
import {
  createApp,
  createTokenIdentity,
  createWorker,
  scopeOf,
  servedByModel,
  type Caller,
  type CorePorts,
} from "@uketsugi/core";
import { toolCaller } from "@uketsugi/testkit";
import { expect, test } from "vitest";
import { candidate, FOUND, scripted, type Script } from "./digest-world.ts";
import { sharedWorld } from "./sharing-world.ts";
import { CLIENT, describeUseCases } from "./use-case-world.ts";

describeUseCases("the model step among several people", (w) => {
  const s = sharedWorld(w);
  const project = "github.com/acme/digest-shared";

  /** A model as Ann, who runs the server, configured it: it serves her and nobody else. */
  const annsModel = (script: Script) =>
    scripted(script, (person) => person.principalId === s.ann.principalId);

  /** A server of Ann's and Bob's with a scripted model, each one's calls on it and its worker. */
  function served(runner: ReturnType<typeof scripted>) {
    // No listener for what a reading did: it is read all the same.
    const worker = createWorker({ ...w.portsWith(w.embedder), runner });
    const ports: CorePorts = { ...w.portsWith(w.embedder), runner, store: worker.store };
    const app = createApp({ ...ports, identity: createTokenIdentity(ports) });
    return {
      ports,
      app,
      calls: (who: Caller) => toolCaller(app, who, CLIENT, project),
      async end(who: Caller, text: string) {
        const conversation = { client: CLIENT.name, id: `of-${who.displayName}`, project };
        await app.noteSession(who, conversation, text);
        await app.endSession(who, conversation);
      },
      async drain() {
        while ((await worker.drain()) > 0);
      },
    };
  }

  test("only the sessions of whoever runs the server are read: another person's text is sent nowhere", async () => {
    const runner = annsModel({
      extract: () => ({ facts: [candidate("Retries live in the queue", ["src/queue/retry.ts"])] }),
    });
    const server = served(runner);
    expect(servedByModel(server.ports, s.ann)).toBe(true);
    expect(servedByModel(server.ports, s.bob)).toBe(false);
    expect(servedByModel(w.portsWith(null), s.ann)).toBe(false);

    await server.calls(s.bob)("publish_fact", {
      claim: "Bob's deploy notes are in the wiki",
      citations: "docs/deploy.md:1",
    });
    await server.end(s.bob, `Bob's private findings. ${FOUND}`);
    // Had he turned on sending each turn, the server would keep none of it: no model reads his.
    const his = { client: CLIENT.name, id: "of-bob", project };
    expect(await server.app.keepTurn(s.bob, his, { answer: `Bob's turn. ${FOUND}` })).toBe(false);
    await server.drain();
    expect(runner.asked).toEqual([]);
    const [mine] = await w.store.sessions.recent(s.bob.orgId, s.bob.principalId, 1);
    expect(mine).toMatchObject({ digestedAt: null, modelTokens: { input: 0, output: 0 } });
    expect(await w.store.jobs.counts()).toMatchObject({ waiting: 0, dead: 0 });

    await server.end(s.ann, FOUND);
    await server.drain();
    expect(runner.askedFor("digest.extract")).toHaveLength(1);
    expect(runner.asked.map((chore) => chore.material).join("\n")).not.toContain("Bob");
  });

  test("a model's fact stays its person's own until they check it, and is put only against that person's facts", async () => {
    const theirs = "The webhook queue retries a failed delivery five times";
    const runner = annsModel({
      extract: () => ({
        facts: [
          candidate("A failed delivery is retried five times by the webhook queue", [
            "src/queue/retry.ts",
          ]),
        ],
      }),
      judge: ({ pairs }) => ({ verdicts: pairs.map(({ n }) => ({ n, verdict: "same" })) }),
    });
    const server = served(runner);
    await s.choose(s.ann, project, "shared");
    await s.choose(s.bob, project, "shared");
    const held = await server.calls(s.bob)("publish_fact", {
      claim: theirs,
      citations: "docs/queue.md:12",
    });
    expect(held.audience).toBe("shared");
    await server.drain();

    await server.end(s.ann, FOUND);
    await server.drain();
    // Bob's fact says the same and Ann can read it, but it is his text: the model was not shown it.
    expect(runner.askedFor("digest.judge")).toEqual([]);
    const page = await w.store.facts.list(scopeOf(s.ann), { project, limit: 10 });
    const written = page.find((fact) => fact.author === s.ann.principalId);
    expect(written?.digestSession).not.toBeNull();
    // A model's word is Ann's alone until she has checked it: Bob is shown nothing of it.
    expect(written).toMatchObject({ audienceId: s.ann.privateAudienceId });
    const unseen = await server.calls(s.bob)("search_facts", { query: "failed delivery retried" });
    expect(unseen.facts.map((fact) => fact.id)).not.toContain(written?.id);
    const hers = await server.calls(s.ann)("search_facts", { query: "failed delivery retried" });
    expect(hers.facts.find((fact) => fact.id === written?.id)).toMatchObject({
      audience: "private",
    });

    // Ann checks it, and it is shared, under her name, with the mark that a model wrote it.
    const checked = await server.calls(s.ann)("update_fact", {
      id: written?.id,
      confirm: { checked: "src/queue/retry.ts" },
    });
    expect(checked).toMatchObject({ status: "confirmed", audience: "shared" });
    const found = await server.calls(s.bob)("search_facts", { query: "failed delivery retried" });
    const view = found.facts.find((fact) => fact.id === written?.id);
    expect(view).toMatchObject({ author: "ann", audience: "shared" });
    expect(view?.from_session).toMatch(/^s-/);
  });
});
