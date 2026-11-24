import type { BriefFact } from "@uketsugi/contracts";
import { describe, expect, test } from "vitest";
import { BRIEF_CLAIM_CHARS, BRIEF_MAX_CHARS, composeBrief } from "../src/brief.ts";
import { fact, previous, sources } from "./brief-fixtures.ts";

describe("what the person told leads the facts", () => {
  const told = [
    fact(1, `Never email founders about a greeting ${"a".repeat(240)}`),
    fact(2, "Release on Tuesdays"),
  ];
  const standing = Array.from({ length: 12 }, (_, n) =>
    fact(10 + n, `Standing fact ${n} ${"b".repeat(150)}`),
  );
  const factLines = (text: string): string[] =>
    text.split("\n").filter((line) => line.startsWith("- "));

  test("facts the person told come first under Facts, then the standing ones, each once", () => {
    const { brief, text } = composeBrief(
      sources({ facts: [...standing.slice(0, 3), told[1] as BriefFact], told, factCount: 14 }),
    );
    expect(brief.facts.map((entry) => entry.id)).toEqual([
      ...told.map((entry) => entry.id),
      ...standing.slice(0, 3).map((entry) => entry.id),
    ]);
    expect(factLines(text)[0]).toContain("Never email founders");
    expect(new Set(factLines(text)).size).toBe(factLines(text).length);
  });

  test("a told fact's line says it cites the person, and no other line does", () => {
    const { text } = composeBrief(sources({ facts: standing.slice(0, 3), told, factCount: 5 }));
    const marked = factLines(text).filter((line) => line.endsWith("(cites your person)"));
    expect(marked).toHaveLength(2);
    expect(marked.every((line) => told.some((entry) => line.includes(entry.id)))).toBe(true);
  });

  test("a told fact the share did not hold is marked where the standing facts list it", () => {
    const many = Array.from({ length: 20 }, (_, n) =>
      fact(100 + n, `Rule ${n} ${"c".repeat(200)}`),
    );
    const { brief, text } = composeBrief(
      sources({ facts: [...many, ...standing], told: many, factCount: 32 }),
    );
    const told = factLines(text).filter((line) => many.some((rule) => line.includes(rule.id)));
    // The share holds four of them at most; the rest are listed among the standing facts.
    expect(told.length).toBeGreaterThan(4);
    expect(told.every((line) => line.endsWith("(cites your person)"))).toBe(true);
    expect(brief.facts.length).toBeGreaterThan(4);
    expect(factLines(text).filter((line) => line.endsWith("(cites your person)"))).toHaveLength(
      told.length,
    );
  });

  test("a told fact a model wrote says so first, then that it cites the person", () => {
    const written = { ...fact(7, "Ship Fridays"), from_session: "session-1" } as BriefFact;
    const { text } = composeBrief(sources({ facts: [written], told: [written], factCount: 1 }));
    expect(factLines(text)[0]).toMatch(/\(written by a model, unchecked\) \(cites your person\)$/);
  });

  test("they take at most their share of the brief's room, and the standing facts keep the rest", () => {
    const many = Array.from({ length: 20 }, (_, n) =>
      fact(100 + n, `Rule ${n} ${"c".repeat(200)}`),
    );
    const { brief, text } = composeBrief(sources({ facts: standing, told: many, factCount: 32 }));
    const lead = brief.facts.filter((entry) => many.some((rule) => rule.id === entry.id));
    const room = lead.reduce((sum, entry) => sum + entry.claim.length + 42, 0);
    expect(lead.length).toBeGreaterThan(0);
    expect(lead.length).toBeLessThan(many.length);
    expect(room).toBeLessThanOrEqual(1000);
    expect(brief.facts.some((entry) => standing.some((other) => other.id === entry.id))).toBe(true);
    expect(text.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
  });

  test("a told fact the previous session's section lists is not listed again", () => {
    const { text } = composeBrief(
      sources({
        previous: { session: previous(), published: [told[1] as BriefFact], digested: [] },
        told,
        facts: standing,
        factCount: 14,
      }),
    );
    expect(factLines(text).filter((line) => line.includes("Release on Tuesdays"))).toHaveLength(1);
  });

  test("a told claim is cut at the brief's one cut", () => {
    const long = fact(1, "x".repeat(BRIEF_CLAIM_CHARS + 50));
    const { brief } = composeBrief(sources({ told: [long], factCount: 1 }));
    expect(brief.facts[0]?.claim).toHaveLength(BRIEF_CLAIM_CHARS);
  });
});
