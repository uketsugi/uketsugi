/**
 * What a brief says the person's last session published, on a clock that moves while a call is
 * answered, as a real one does. A call is stamped on its session when it arrives and its fact is
 * written a moment later, so a session's last publish is newer than the session's last call: it is
 * found by the session its publishing was recorded in, not by when it was written.
 */
import { createApp, createTokenIdentity, SESSION_IDLE_MS, type Clock } from "@uketsugi/core";
import { toolCaller } from "@uketsugi/testkit";
import { expect, test } from "vitest";
import { CLIENT, describeUseCases } from "./use-case-world.ts";

describeUseCases("the brief's account of the last session", (w) => {
  test("lists what the session published last, though it was written after the session's last call", async () => {
    // A millisecond passes every time the clock is read.
    const moving: Clock = {
      now: () => {
        w.clock.advance(1);
        return w.clock.now();
      },
      timeout: (ms) => w.clock.timeout(ms),
    };
    const ports = { ...w.portsWith(null), clock: moving };
    const app = createApp({ ...ports, identity: createTokenIdentity(ports) });
    const project = "github.com/acme/brief-published";
    const call = toolCaller(app, w.owner, CLIENT, project);

    await call("search_facts", { query: "how are refunds settled" });
    const last = await call("publish_fact", {
      claim: "Refunds are settled nightly by the batch job",
      citations: "src/refunds.ts:9",
    });
    const { orgId, principalId } = w.owner;
    const session = await w.store.sessions.latest(orgId, principalId, project);
    const fact = await w.factOf(last.id);
    expect(fact.createdAt.getTime()).toBeGreaterThan(session?.lastCallAt.getTime() ?? Infinity);

    w.clock.advance(SESSION_IDLE_MS + 1);
    const next = await call("search_facts", { query: "refunds" });
    expect(next.brief?.last_session?.published).toEqual([
      { id: last.id, claim: "Refunds are settled nightly by the batch job", trust: "unreviewed" },
    ]);
    expect(next.text).toContain("Facts published while it ran:");
  });
});
