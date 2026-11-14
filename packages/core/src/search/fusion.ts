/**
 * Relevance: the passes the store ran are fused by weighted reciprocal rank, and a candidate that
 * only loose wording found is dropped. Pure arithmetic over what the store returned.
 */
import type { SearchPass } from "../search-port.ts";

/**
 * The values this build searches with. The admission values and the strong cosine were fitted on the
 * team fact set with the pinned embedding model; another model needs them fitted again.
 */
export const SEARCH_PROFILE = {
  /** The constant added to a rank before it divides its pass's weight. */
  rankConstant: 60,
  weights: { keyword: 1.0, identifier: 1.5, trigram: 0.5, vector: 1.0 },
  /** How many facts each pass keeps. */
  passLimit: 50,
  /** A fact with a vector enters the keyword pass only when its own text holds this share of the query's lexemes. */
  coverageAdmission: 0.6,
  /** A fact only wording found, far from the query in meaning, must still hold this share of its lexemes. */
  keywordFloor: 0.25,
  /** The vector pass keeps facts at or above this cosine. */
  vectorCutoff: 0.78,
  /** The trigram pass keeps facts at or above this word similarity. */
  trigramThreshold: 0.5,
  /** Evidence that makes a result's confidence strong: this lexeme coverage, or this cosine. */
  strongCoverage: 0.6,
  strongCosine: 0.83,
  /** Standing: another author's unconfirmed fact, a flagged fact, and the recency curve. */
  otherAuthorUnconfirmed: 0.85,
  flagged: 0.8,
  recencyFloor: 0.85,
  recencyDecayDays: 90,
} as const;

/** The passes in the order a result lists them. */
const SEARCH_PASSES: readonly SearchPass[] = ["keyword", "identifier", "trigram", "vector"];

/** A fact's 1-based rank in each pass that kept it. */
export type PassRanks = Readonly<Partial<Record<SearchPass, number>>>;

/** Each fact's ranks, gathered from the rows the passes returned. */
export function ranksByFact(
  rows: readonly { factId: string; pass: SearchPass; rank: number }[],
): Map<string, PassRanks> {
  const ranks = new Map<string, PassRanks>();
  for (const row of rows) ranks.set(row.factId, { ...ranks.get(row.factId), [row.pass]: row.rank });
  return ranks;
}

/** Weighted reciprocal-rank fusion: the sum over a fact's passes of weight / (rank constant + rank). */
export function relevanceOf(ranks: PassRanks): number {
  const { rankConstant, weights } = SEARCH_PROFILE;
  return SEARCH_PASSES.reduce((sum, pass) => {
    const rank = ranks[pass];
    return rank === undefined ? sum : sum + weights[pass] / (rankConstant + rank);
  }, 0);
}

/** What the keyword floor reads of a candidate. */
export interface FloorEvidence {
  readonly ranks: PassRanks;
  /** The cosine of the fact's vector with the query's; null when either has none. */
  readonly cosine: number | null;
  /** The share of the query's lexemes the fact's own text holds. */
  readonly lexemeCoverage: number;
}

/**
 * Whether a candidate stands. It fails only when wording alone found it (the keyword and trigram
 * passes), its cosine is known and under the vector cut-off, and its own text holds under the
 * keyword floor of the query's lexemes. Identifier or vector evidence, or no cosine to judge by
 * (a fact not yet embedded, a search with no model), clears it.
 */
export function clearsKeywordFloor(candidate: FloorEvidence): boolean {
  const { ranks, cosine, lexemeCoverage } = candidate;
  if (ranks.identifier !== undefined || ranks.vector !== undefined) return true;
  if (cosine === null || cosine >= SEARCH_PROFILE.vectorCutoff) return true;
  return lexemeCoverage >= SEARCH_PROFILE.keywordFloor;
}
