import { describe, expect, test } from "vitest";
import type { CandidateRow } from "../src/search-port.ts";
import {
  clearsKeywordFloor,
  ranksByFact,
  relevanceOf,
  SEARCH_PROFILE,
} from "../src/search/fusion.ts";
import { confidenceOf, rankCandidates, factStanding } from "../src/search/standing.ts";
import { extractIdentifiers, normalizeText } from "../src/text/analyze.ts";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const DAY = 86_400_000;
const ME = "me";

function row(factId: string, change: Partial<CandidateRow> = {}): CandidateRow {
  return {
    factId,
    cosine: null,
    lexemeCoverage: 1,
    status: "unconfirmed",
    author: ME,
    flagged: false,
    updatedAt: NOW,
    confirmedAt: null,
    ...change,
  };
}

describe("text analysis", () => {
  test("normalizing folds width, case and runs of white space", () => {
    expect(normalizeText("  Ｗebhook\tRETRY \n schedule ")).toBe("webhook retry schedule");
  });

  test.each([
    ["error PAY-4021 on checkout", ["pay-4021"]],
    [
      "set SAML_CLOCK_SKEW_SECONDS, then ECONNRESET stops.",
      ["saml_clock_skew_seconds", "econnreset"],
    ],
    ["upgrade to v2.3.1 from 2.3.0", ["v2.3.1", "2.3.1", "2.3.0"]],
    [
      "see `billing/dunning/schedule.ts` (fs.readFile)",
      ["billing/dunning/schedule.ts", "schedule.ts", "fs.readfile"],
    ],
    ["src/retry.ts:41-88 drops it", ["src/retry.ts:41-88", "src/retry.ts", "retry.ts"]],
    ["the gateway answers with status 502, i.e. after 3 retries", ["502"]],
    ["Sessions expire after thirty minutes, e.g. overnight", []],
  ])("the identifiers of %j are %j", (text, identifiers) => {
    expect(extractIdentifiers(text)).toEqual(identifiers);
  });

  test("identifiers are deduplicated and capped", () => {
    const many = Array.from({ length: 80 }, (_, n) => `ID-${n}`).join(" ");
    expect(extractIdentifiers(`${many} ID-0`)).toHaveLength(64);
  });
});

describe("fusion", () => {
  test("relevance sums weight over rank constant plus rank, per pass", () => {
    expect(relevanceOf({ keyword: 1 }, SEARCH_PROFILE)).toBeCloseTo(1 / 61, 12);
    expect(
      relevanceOf({ keyword: 2, identifier: 1, trigram: 3, vector: 4 }, SEARCH_PROFILE),
    ).toBeCloseTo(1 / 62 + 1.5 / 61 + 0.5 / 63 + 1 / 64, 12);
  });

  test("two passes at a low rank beat one pass at the top, and an identifier beats a keyword", () => {
    expect(relevanceOf({ keyword: 20, vector: 20 }, SEARCH_PROFILE)).toBeGreaterThan(
      relevanceOf({ keyword: 1 }, SEARCH_PROFILE),
    );
    expect(relevanceOf({ identifier: 1 }, SEARCH_PROFILE)).toBeGreaterThan(
      relevanceOf({ keyword: 1 }, SEARCH_PROFILE),
    );
  });

  test("the passes' rows are gathered into each fact's ranks", () => {
    const ranks = ranksByFact([
      { factId: "a", pass: "keyword", rank: 2 },
      { factId: "b", pass: "keyword", rank: 1 },
      { factId: "a", pass: "trigram", rank: 1 },
    ]);
    expect(ranks.get("a")).toEqual({ keyword: 2, trigram: 1 });
    expect(ranks.get("b")).toEqual({ keyword: 1 });
  });

  test.each([
    ["wording alone, far in meaning, few lexemes", { keyword: 1 }, 0.5, 0.2, false],
    ["wording alone, far in meaning, enough lexemes", { keyword: 1, trigram: 1 }, 0.5, 0.25, true],
    ["wording alone, close in meaning", { keyword: 1 }, 0.78, 0, true],
    ["wording alone, no cosine to judge by", { trigram: 1 }, null, 0, true],
    ["an identifier", { keyword: 1, identifier: 1 }, 0.1, 0, true],
    ["the vector pass", { vector: 1 }, 0.9, 0, true],
  ])("the keyword floor: %s", (_name, ranks, cosine, lexemeCoverage, clears) => {
    expect(clearsKeywordFloor({ ranks, cosine, lexemeCoverage }, SEARCH_PROFILE)).toBe(clears);
  });
});

describe("standing", () => {
  test("a fresh fact of the reader's own, unflagged, loses nothing", () => {
    expect(factStanding(row("a"), ME, NOW, SEARCH_PROFILE)).toEqual({
      status: 1,
      flagged: 1,
      recency: 1,
    });
  });

  test("another author's unconfirmed fact stands lower until it is confirmed", () => {
    expect(factStanding(row("a", { author: "them" }), ME, NOW, SEARCH_PROFILE).status).toBe(0.85);
    expect(
      factStanding(row("a", { author: "them", status: "confirmed" }), ME, NOW, SEARCH_PROFILE)
        .status,
    ).toBe(1);
  });

  test("a flag lowers a fact once", () => {
    expect(factStanding(row("a", { flagged: true }), ME, NOW, SEARCH_PROFILE).flagged).toBe(0.8);
  });

  test("recency decays towards its floor, and a confirmation restarts it", () => {
    const old = new Date(NOW.getTime() - 90 * DAY);
    expect(factStanding(row("a", { updatedAt: old }), ME, NOW, SEARCH_PROFILE).recency).toBeCloseTo(
      0.85 + 0.15 / Math.E,
      12,
    );
    const ancient = new Date(NOW.getTime() - 5000 * DAY);
    expect(
      factStanding(row("a", { updatedAt: ancient }), ME, NOW, SEARCH_PROFILE).recency,
    ).toBeCloseTo(0.85, 6);
    expect(
      factStanding(row("a", { updatedAt: old, confirmedAt: NOW }), ME, NOW, SEARCH_PROFILE).recency,
    ).toBe(1);
  });
});

describe("the final order", () => {
  const ranks = new Map([
    ["a", { keyword: 1 }],
    ["b", { keyword: 2 }],
    ["c", { keyword: 3 }],
  ]);

  test("score orders, then the newer fact, then the higher id", () => {
    const tied = new Map([
      ["a", { keyword: 1 }],
      ["b", { vector: 1 }],
      ["c", { vector: 1 }],
    ]);
    const newer = new Date(NOW.getTime() + 1);
    const rows = [row("a"), row("b"), row("c", { updatedAt: newer })];
    const ordered = rankCandidates(rows, tied, ME, newer, SEARCH_PROFILE);
    expect(ordered.map((candidate) => candidate.factId)).toEqual(["c", "b", "a"]);
  });

  test("a flagged fact at the top of its pass falls below the clean ones", () => {
    const rows = [row("a", { flagged: true }), row("b"), row("c")];
    const ordered = rankCandidates(rows, ranks, ME, NOW, SEARCH_PROFILE);
    expect(ordered.map((candidate) => candidate.factId)).toEqual(["b", "c", "a"]);
    expect(ordered[2]).toMatchObject({ relevance: 1 / 61, score: 0.013115 });
  });

  test("a fact under the keyword floor is dropped, and one no pass ranked is ignored", () => {
    const rows = [row("a", { cosine: 0.4, lexemeCoverage: 0.1 }), row("b"), row("z")];
    const ordered = rankCandidates(rows, ranks, ME, NOW, SEARCH_PROFILE);
    expect(ordered.map((candidate) => candidate.factId)).toEqual(["b"]);
  });
});

describe("confidence", () => {
  const weak = { ranks: { keyword: 1 }, cosine: 0.8, lexemeCoverage: 0.3 };

  test.each([
    ["identifier", { ...weak, ranks: { identifier: 1 } }],
    ["coverage", { ...weak, lexemeCoverage: 0.6 }],
    ["cosine", { ...weak, cosine: 0.83 }],
  ] as const)("is strong on %s evidence", (test, candidate) => {
    expect(confidenceOf([weak, candidate], SEARCH_PROFILE)).toEqual({ confidence: "strong", test });
  });

  test("is low with no evidence at the head, wherever else it lies", () => {
    expect(confidenceOf([], SEARCH_PROFILE)).toEqual({ confidence: "low", test: "none" });
    const strong = { ...weak, lexemeCoverage: 1 };
    expect(confidenceOf([weak, weak, weak, strong], SEARCH_PROFILE).confidence).toBe("low");
  });
});
