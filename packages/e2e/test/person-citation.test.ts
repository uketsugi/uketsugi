/**
 * What the block lets an agent cite for a rule the person told it: their words, as an object or as
 * prose. Both are stored, as testimony, and the fact is found again.
 */
import { expect, test } from "vitest";
import { serverWith } from "./digest-world.ts";
import { describeUseCases } from "./use-case-world.ts";

describeUseCases("a fact cited to the person", (w) => {
  test.each([
    [
      "an object",
      { kind: "person", who: "the person, in this session", at: "do not email founders" },
    ],
    ["prose", "the person said: do not email founders about greetings"],
  ])("a publish cited to the person as %s is stored as testimony", async (_name, citation) => {
    const server = serverWith(w, undefined);
    const published = await server.call("publish_fact", {
      claim: "Founders are not emailed when a greeting changes",
      citations: [citation],
    });
    const [fact] = await w.store.facts.list(w.scope, { project: server.project, limit: 5 });
    expect(fact?.id).toBe(published.id);
    expect(fact?.citations).toHaveLength(1);
    expect(fact?.citations[0]?.class).toBe("testimony");
  });
});
