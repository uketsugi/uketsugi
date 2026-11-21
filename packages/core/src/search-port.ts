/**
 * The search statements of the Store port. Search runs in the store, as PostgreSQL does it:
 * full-text ranked by `ts_rank_cd` and admitted by lexeme coverage, identifiers, cosine on the
 * stored vectors, and trigram word similarity over the other passes' candidates only. Core fuses
 * the ranks and applies standing; the store never orders a final result.
 *
 * A fact is admitted by its own text (claim and detail), its identifiers or its vector. By its
 * wording a question never admits its fact: it adds to the keyword score of one its own text
 * admitted. It is part of what the fact's vector is made from, so it can admit it by meaning.
 */
import type { ReadScope, Status } from "./domain.ts";
import type { ModelVector } from "./ports.ts";

/** One stream of candidates. */
export type SearchPass = "keyword" | "identifier" | "trigram" | "vector";

/** What every search statement is given. */
export interface SearchQuery {
  /** The reader's organization and visible audiences: no statement runs without them. */
  readonly scope: ReadScope;
  /** A hard filter: only facts published in this project. */
  readonly project: string;
  /** The query as the caller wrote it. */
  readonly query: string;
  /** Normalized identifiers found in the query, for the identifier pass. */
  readonly idents: readonly string[];
  /**
   * The query's vector and the id of the model that made it; null skips the vector pass, and the
   * result says so. A store whose vectors were made by another model skips it too.
   */
  readonly embedding: ModelVector | null;
  /** The vector pass keeps facts at or above this cosine. */
  readonly vectorCutoff: number;
  /** A fact that has a vector enters the keyword pass only when its own text holds at least this share of the query's lexemes. */
  readonly admissionCoverage: number;
  /** The trigram pass keeps facts whose word similarity with the query is at or above this. */
  readonly trigramThreshold: number;
  /** How many facts each pass keeps. */
  readonly passLimit: number;
}

/** A fact a pass kept, with its 1-based rank in that pass. */
export interface PassRow {
  readonly factId: string;
  readonly pass: SearchPass;
  readonly rank: number;
}

/** A kept fact with what fusion and standing read besides rank, as its row stands at this moment. */
export interface CandidateRow {
  readonly factId: string;
  /** The cosine of the fact's vector with the query's; null when either has none. */
  readonly cosine: number | null;
  /** The share of the query's lexemes the fact's own text holds, from 0 to 1. */
  readonly lexemeCoverage: number;
  readonly status: Status;
  readonly author: string;
  /** Whether the fact has an open flag that is not a proposal. */
  readonly flagged: boolean;
  readonly updatedAt: Date;
  /** The newest confirmation of the fact, if it has one. */
  readonly confirmedAt: Date | null;
}

/** The ranked passes over the live facts of a project. Superseded facts and stubs are never candidates. */
export interface SearchRepo {
  /** The keyword, identifier and vector passes in one scan, each pass's top `passLimit`. */
  passes(query: SearchQuery): Promise<PassRow[]>;
  /** The trigram pass over the facts `candidateIds` names, and only those. */
  trigram(query: SearchQuery, candidateIds: readonly string[]): Promise<PassRow[]>;
  /** What fusion and standing read of the facts the passes kept. */
  candidates(query: SearchQuery, factIds: readonly string[]): Promise<CandidateRow[]>;
}
