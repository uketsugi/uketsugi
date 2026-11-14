/**
 * What a tool result says of who can see a fact. A project's treatment says what its person
 * shares there, not where one fact is: on a server with several people, a result that stores or
 * shows a fact says it of that fact, and why when the fact is its author's alone in a project
 * they share. On a host with one person a result says none of it and reads as it always has.
 */
import { factDetail, redactFact } from "@uketsugi/core";
import { expect, test } from "vitest";
import { CHECKABLE, sharedWorld } from "./sharing-world.ts";
import { describeUseCases } from "./use-case-world.ts";

const P = (name: string): string => `github.com/acme/results-${name}`;

describeUseCases("a result on a server with several people", (w) => {
  const s = sharedWorld(w);

  test("a result that stores or shows a fact says who can see that fact, and why a fact in a shared project is its author's alone", async () => {
    const project = P("says-who");
    const ann = s.calls(s.ann, project);
    const early = await ann("publish_fact", { claim: "Logs rotate weekly", citations: CHECKABLE });
    expect(early).toMatchObject({ audience: "private", private_because: "project" });
    expect(early.text).toContain(
      `fact: private · only your person sees it\nproject: ${project} · used here, private`,
    );
    await s.choose(s.ann, project, "shared");

    const sourced = await ann("publish_fact", {
      claim: "Logs are shipped to the archive daily",
      citations: CHECKABLE,
    });
    const heard = await ann("publish_fact", {
      claim: "The archive is kept for seven years",
      citations: [{ kind: "person", who: "the compliance lead" }],
    });
    expect(sourced).toMatchObject({ audience: "shared" });
    expect(sourced).not.toHaveProperty("private_because");
    expect(sourced.text).toContain(
      `fact: shared · everyone on this server sees it\nproject: ${project} · used here, shared`,
    );
    expect(heard).toMatchObject({ audience: "private", private_because: "no_source" });
    expect(heard.text).toContain(
      `fact: private · only your person sees it · none of its citations is checkable\nproject: ${project} · used here, shared`,
    );
    const resting = await ann("publish_fact", {
      claim: "Old logs are deleted after the archive confirms them",
      citations: ["src/logs.ts:2", { kind: "fact", fact: heard.id }],
    });
    expect(resting.text).toContain("only your person sees it · it cites a fact others cannot see");

    const fixed = await ann("update_fact", { id: heard.id, citations: ["docs/retention.md:1"] });
    expect(fixed).toMatchObject({ audience: "shared" });
    expect(fixed.text).toContain("fact: shared · everyone on this server sees it");
    await s.choose(s.bob, project, "shared");
    const confirmed = await s.calls(s.bob, project)("update_fact", {
      id: sourced.id,
      confirm: { checked: "read the shipping job" },
    });
    expect(confirmed.text).toContain("fact: shared · everyone on this server sees it");

    const found = await ann("search_facts", { query: "logs archive" });
    const seen = new Map(found.facts.map((fact) => [fact.id, fact.audience]));
    expect(seen.get(early.id)).toBe("shared");
    expect(seen.get(resting.id)).toBe("shared");
    await ann("update_fact", { id: resting.id, citations: [{ kind: "person", who: "ops" }] });
    const again = await ann("search_facts", { query: "old logs deleted archive confirms" });
    expect(again.facts.find((fact) => fact.id === resting.id)?.audience).toBe("private");
    expect(again.text).toMatch(/ · by you · private · \d{4}-/);
    expect(again.text).toMatch(/ · by you · shared · \d{4}-/);
  });

  test("a fact that cites its author's private fact stays private once that fact is redacted, until it drops the citation", async () => {
    const project = P("cites-a-stub");
    await s.choose(s.ann, project, "shared");
    const ann = s.calls(s.ann, project);
    const base = await ann("publish_fact", {
      claim: "The vendor confirmed the limit by phone",
      citations: [{ kind: "person", who: "the vendor's support line" }],
    });
    const resting = await ann("publish_fact", {
      claim: "Uploads above the vendor's limit are split",
      citations: ["src/upload.ts:31", { kind: "fact", fact: base.id }],
    });
    expect(resting).toMatchObject({ audience: "private", private_because: "cites_private" });

    // A redacted fact stays its author's alone whatever she chooses, so what cites it is held
    // back for good: this is the case the fact's page has to tell her the way out of.
    await redactFact(s.ports, s.ann, { id: base.id });
    expect((await s.choose(s.ann, project, "shared")).moved.facts).toBe(0);
    expect((await factDetail(s.ports, s.ann, resting.id)).private_because).toBe("cites_private");

    // The way out the page gives: her agent corrects the fact without that citation.
    const freed = await ann("update_fact", { id: resting.id, citations: ["src/upload.ts:31"] });
    expect(freed).toMatchObject({ audience: "shared" });
    expect(await factDetail(s.ports, s.ann, resting.id)).not.toHaveProperty("private_because");
    expect((await factDetail(s.ports, s.bob, resting.id)).fact.id).toBe(resting.id);
  });
});

describeUseCases("a host with one person", (w) => {
  test("says nothing of who sees a fact: its results are as they were", async () => {
    const published = await w.plain("publish_fact", {
      claim: "Only one person is here",
      citations: [{ kind: "person", who: "nobody else" }],
    });
    const updated = await w.plain("update_fact", { id: published.id, detail: "Still one." });
    const found = await w.plain("search_facts", { query: "one person here" });

    for (const result of [published, updated, ...found.facts]) {
      expect(result).not.toHaveProperty("audience");
      expect(result).not.toHaveProperty("private_because");
    }
    const lines = (text: string): string[] => text.split("\n");
    expect(lines(published.text).slice(0, 4)).toEqual([
      `published ${published.id} · unconfirmed`,
      "citation 1: nobody else (testimony, a person said so)",
      expect.stringMatching(/^project: .* · used here, private$/) as string,
      expect.stringMatching(/^session: /) as string,
    ]);
    expect(updated.text).not.toContain("fact:");
    expect(found.text).toMatch(/ · by you · \d{4}-/);
    expect((await factDetail(w.portsWith(null), w.owner, published.id)).private_because).toBe(
      undefined,
    );
  });
});
