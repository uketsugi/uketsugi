/**
 * Standing: how a relevant fact stands at the moment of the search, read from its store row, so a
 * confirmation or a flag takes effect at once. Then the final order and the result's confidence.
 */
import type { CandidateRow } from "../search-port.ts";
import {
  clearsKeywordFloor,
  relevanceOf,
  type FloorEvidence,
  type PassRanks,
  type SearchProfile,
} from "./fusion.ts";

const MS_PER_DAY = 86_400_000;
/** Confidence reads the evidence of this many facts at the head of the order. */
const CONFIDENCE_WINDOW = 3;

/** The factors a relevance is multiplied by. Each is 1 when it takes nothing away. */
export interface Standing {
  /** Another author's unconfirmed fact stands lower than a confirmed one or the reader's own. */
  readonly status: number;
  /** A fact with an open flag stands lower, once however many flags it has. */
  readonly flagged: number;
  /** Decays with the days since the fact was last written or confirmed, never below the floor. */
  readonly recency: number;
}

type StandingRow = Pick<
  CandidateRow,
  "status" | "author" | "flagged" | "updatedAt" | "confirmedAt"
>;

/** What the factors come to together: what a fact's relevance is multiplied by. */
export function standingWeight(standing: Standing): number {
  return standing.status * standing.flagged * standing.recency;
}

/** How a fact stands for a reader at an instant. */
export function factStanding(
  row: StandingRow,
  reader: string,
  now: Date,
  profile: SearchProfile,
): Standing {
  const lowered = row.status === "unconfirmed" && row.author !== reader;
  const checked = Math.max(row.updatedAt.getTime(), row.confirmedAt?.getTime() ?? 0);
  const ageDays = Math.max(0, now.getTime() - checked) / MS_PER_DAY;
  return {
    status: lowered ? profile.otherAuthorUnconfirmed : 1,
    flagged: row.flagged ? profile.flagged : 1,
    recency:
      profile.recencyFloor +
      (1 - profile.recencyFloor) * Math.exp(-ageDays / profile.recencyDecayDays),
  };
}

/** A candidate with everything its place in the order came from. */
export interface RankedCandidate extends FloorEvidence {
  readonly factId: string;
  /** The fused relevance, before standing. */
  readonly relevance: number;
  readonly standing: Standing;
  /** Relevance times the standing factors, rounded to 6 decimals. */
  readonly score: number;
  readonly updatedAt: Date;
}

/**
 * Fuses, admits and orders the candidates: best score first, then the newest, then the higher id.
 * A row whose fact no pass ranked is ignored.
 */
export function rankCandidates(
  rows: readonly CandidateRow[],
  ranks: ReadonlyMap<string, PassRanks>,
  reader: string,
  now: Date,
  profile: SearchProfile,
): RankedCandidate[] {
  const ranked = rows.flatMap((row): RankedCandidate[] => {
    const own = ranks.get(row.factId);
    if (own === undefined) return [];
    const evidence = { ranks: own, cosine: row.cosine, lexemeCoverage: row.lexemeCoverage };
    if (!clearsKeywordFloor(evidence, profile)) return [];
    const relevance = relevanceOf(own, profile);
    const standing = factStanding(row, reader, now, profile);
    const score = relevance * standingWeight(standing);
    return [
      {
        ...evidence,
        factId: row.factId,
        relevance,
        standing,
        score: Math.round(score * 1e6) / 1e6,
        updatedAt: row.updatedAt,
      },
    ];
  });
  return ranked.sort(
    (a, b) =>
      b.score - a.score ||
      b.updatedAt.getTime() - a.updatedAt.getTime() ||
      (a.factId < b.factId ? 1 : a.factId > b.factId ? -1 : 0),
  );
}

/** What made a result's confidence strong, or `none`. */
export type ConfidenceTest = "identifier" | "coverage" | "cosine" | "none";

/** The strong evidence a fact's own text or vector gives, apart from an identifier, or `none`. */
export function strongMatch(
  candidate: Pick<FloorEvidence, "cosine" | "lexemeCoverage">,
  profile: SearchProfile,
): ConfidenceTest {
  if (candidate.lexemeCoverage >= profile.strongCoverage) return "coverage";
  if (candidate.cosine !== null && candidate.cosine >= profile.strongCosine) return "cosine";
  return "none";
}

function evidenceOf(candidate: FloorEvidence, profile: SearchProfile): ConfidenceTest {
  if (candidate.ranks.identifier !== undefined) return "identifier";
  return strongMatch(candidate, profile);
}

/**
 * Strong when a fact at the head of the order matched an identifier of the query, holds most of its
 * lexemes, or is close to it in meaning. Low lets the reader abstain.
 */
export function confidenceOf(
  ordered: readonly FloorEvidence[],
  profile: SearchProfile,
): { confidence: "strong" | "low"; test: ConfidenceTest } {
  for (const candidate of ordered.slice(0, CONFIDENCE_WINDOW)) {
    const test = evidenceOf(candidate, profile);
    if (test !== "none") return { confidence: "strong", test };
  }
  return { confidence: "low", test: "none" };
}
