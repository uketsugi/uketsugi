/**
 * What the person told an agent leads the brief: a fact cited only to the person is listed first
 * under Facts, however many newer facts the project holds, and a fact that cites a file as well is
 * left where its age puts it.
 */
import { expect, test } from "vitest";
import { serverWith } from "./digest-world.ts";
import { describeUseCases } from "./use-case-world.ts";

describeUseCases("the person's words lead the brief", (w) => {
  test("an old fact cited only to the person leads a brief that newer facts would fill", async () => {
    const server = serverWith(w, undefined);
    const told = await server.call("publish_fact", {
      claim: "Never email founders when a greeting changes",
      citations: [{ kind: "person", who: "the user, in this session" }],
    });
    const mixed = await server.call("publish_fact", {
      claim: "Greetings are stored per channel",
      citations: [{ kind: "person", who: "the user" }, "irc/greetings.go:10-20"],
    });
    for (let n = 0; n < 70; n += 1) {
      await server.call("publish_fact", {
        claim: `Handler ${n} validates its input before it writes ${"x".repeat(80)}`,
        citations: [`irc/handler${n}.go:1-9`],
      });
    }
    const first = await server.another("search_facts", { query: "greetings" });
    const listed = first.brief?.facts.map((entry) => entry.id) ?? [];
    expect(listed[0]).toBe(told.id);
    expect(listed.indexOf(mixed.id)).not.toBe(1);
    expect(first.text).toContain(`- ${told.id} · Never email founders when a greeting changes`);
  });

  test("superseded facts cited only to the person do not take the slots of the live one", async () => {
    const server = serverWith(w, undefined);
    const told = await server.call("publish_fact", {
      claim: "Release notes are written by the person who merges",
      citations: [{ kind: "person", who: "the user" }],
    });
    // Each pair merges: the person's fact is superseded by a duplicate that cites a file, so the
    // survivor is not the person's alone. More such facts than the told pool holds, and newer.
    for (let n = 0; n < 25; n += 1) {
      const claim = `Retry policy number ${n} backs off twice before it gives up`;
      await server.call("publish_fact", {
        claim,
        citations: [{ kind: "person", who: "the user" }],
      });
      await server.call("publish_fact", { claim: `${claim}.`, citations: `irc/retry${n}.go:1-9` });
    }
    for (let n = 0; n < 40; n += 1) {
      await server.call("publish_fact", {
        claim: `Handler ${n} validates its input before it writes ${"x".repeat(80)}`,
        citations: [`irc/handler${n}.go:1-9`],
      });
    }
    await server.drain();
    const superseded = (
      await w.store.facts.list(w.scope, { project: server.project, limit: 500 })
    ).filter(
      (fact) =>
        fact.status === "superseded" && fact.citations.every((c) => c.citation.kind === "person"),
    );
    expect(superseded.length).toBeGreaterThan(20);
    const only = await w.store.facts.list(w.scope, {
      project: server.project,
      citedOnlyToPerson: true,
      limit: 20,
    });
    expect(only.map((fact) => fact.id)).toEqual([told.id]);
    const first = await server.another("search_facts", { query: "release notes" });
    expect(first.brief?.facts[0]?.id).toBe(told.id);
  });
});
