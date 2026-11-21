import {
  noConfidentMatch,
  NOTHING_FOUND,
  type SearchFactsInput,
  type SearchFactsResult,
} from "@uketsugi/contracts";
import { embedWithin, liveHeads, scopeOf, type CallContext, type Outcome } from "../../context.ts";
import type { Fact } from "../../domain.ts";
import { factViews } from "../../facts/views.ts";
import { invalidInput } from "../../failure.ts";
import type { CorePorts, ModelVector } from "../../ports.ts";
import type { SearchQuery } from "../../search-port.ts";
import { ranksByFact, SEARCH_PROFILE } from "../../search/fusion.ts";
import { confidenceOf, rankCandidates, type RankedCandidate } from "../../search/standing.ts";
import { extractIdentifiers, normalizeText } from "../../text/analyze.ts";
import { factInProject } from "./write.ts";

type SearchOutcome = Outcome<SearchFactsResult>;

/** Whose search it is and where: all a search reads of a call. */
type Asker = Pick<CallContext, "caller" | "project">;

/** How long a search waits for the query's vector before it runs on the lexical passes alone. */
const QUERY_EMBED_BUDGET_MS = 1500;
/** The most candidates an explanation lists. */
const EXPLAIN_LIMIT = 50;

/** One fact by id, with the live fact at the head of its chain when it is superseded. */
async function byId(ports: CorePorts, ctx: Asker, id: string): Promise<SearchOutcome> {
  const scope = scopeOf(ctx.caller);
  const fact = await factInProject(ports, ctx, id);
  const chain = fact === null ? [] : [fact];
  const heads = await liveHeads(ports, scope, chain);
  const head = fact === null ? undefined : heads.get(fact.id);
  const live = head === undefined ? null : await ports.store.facts.get(scope, head);
  if (live !== null) chain.push(live);
  const facts = await factViews(ports, ctx.caller, chain, heads);
  const found = facts.length > 0;
  return {
    matched: facts.length,
    shown: facts.length,
    confidence: found ? "strong" : "low",
    facts,
    ...(found ? {} : { message: NOTHING_FOUND }),
  };
}

/**
 * The query's vector, or why there is none. A model that does not answer within the budget is not
 * waited for: the search runs on the lexical passes and the result says so.
 */
async function embedQuery(
  ports: CorePorts,
  text: string,
): Promise<{ vector: ModelVector | null; degraded: string[] }> {
  if (ports.embedder === null) return { vector: null, degraded: ["no_model"] };
  try {
    const vector = await embedWithin(ports, text, "query", QUERY_EMBED_BUDGET_MS);
    return { vector, degraded: [] };
  } catch {
    // The lexical passes still answer; the result says the vector pass was skipped.
    return { vector: null, degraded: ["embedder_unavailable"] };
  }
}

/** A query's facts in their final order, and everything the order came from. */
export interface Ranking {
  /** The facts shown, best first. */
  readonly facts: Fact[];
  /** How many facts matched, shown or not. */
  readonly matched: number;
  readonly verdict: ReturnType<typeof confidenceOf>;
  /** What was skipped, for example `no_model`. */
  readonly degraded: string[];
  readonly query: SearchQuery;
  readonly ranked: readonly RankedCandidate[];
}

/**
 * Ranks the facts the asker may see in one project for a query (flow F3). Four passes run in the
 * store under the asker's visible set; their ranks are fused, loose matches are dropped, and each
 * fact's standing is read from its row. The agents' search and the dashboard's are both this.
 */
export async function rankFacts(
  ports: CorePorts,
  ctx: Asker,
  text: string,
  limit: number,
): Promise<Ranking> {
  const scope = scopeOf(ctx.caller);
  const { vector, degraded } = await embedQuery(ports, text);
  const query: SearchQuery = {
    scope,
    project: ctx.project.key,
    query: text,
    idents: extractIdentifiers(text),
    embedding: vector,
    vectorCutoff: SEARCH_PROFILE.vectorCutoff,
    admissionCoverage: SEARCH_PROFILE.coverageAdmission,
    trigramThreshold: SEARCH_PROFILE.trigramThreshold,
    passLimit: SEARCH_PROFILE.passLimit,
  };
  const { search, facts } = ports.store;
  const kept = await search.passes(query);
  const ids = [...new Set(kept.map((row) => row.factId))];
  const [near, rows] = await Promise.all([
    search.trigram(query, ids),
    search.candidates(query, ids),
  ]);
  const ranks = ranksByFact([...kept, ...near]);
  const ranked = rankCandidates(rows, ranks, ctx.caller.principalId, ports.clock.now());
  const head = ranked.slice(0, limit);
  const stored = await facts.getMany(
    scope,
    head.map((candidate) => candidate.factId),
  );
  const inOrder = head.flatMap(({ factId }) => stored.filter((fact) => fact.id === factId));
  return {
    facts: inOrder,
    matched: ranked.length,
    verdict: confidenceOf(head),
    degraded,
    query,
    ranked,
  };
}

/** The ranking's reasoning: how the query was read, what was skipped, and every candidate's place and why. */
function explanation(ranking: Ranking, shown: number): Record<string, unknown> {
  const { query, ranked, verdict, degraded } = ranking;
  return {
    query: {
      normalized: normalizeText(query.query),
      identifiers: query.idents,
      embedded: query.embedding !== null,
    },
    skipped: degraded.map((reason) => ({ pass: "vector", reason })),
    confidence: verdict,
    profile: SEARCH_PROFILE,
    candidates: ranked.slice(0, EXPLAIN_LIMIT).map((candidate, index) => ({
      id: candidate.factId,
      position: index + 1,
      shown: index < shown,
      ranks: candidate.ranks,
      relevance: candidate.relevance,
      cosine: candidate.cosine,
      lexeme_coverage: candidate.lexemeCoverage,
      standing: candidate.standing,
      score: candidate.score,
    })),
  };
}

/**
 * Searches the facts the caller may see in the call's project. The result says how many facts
 * matched and how many it shows. When nothing at the head of the order is strong evidence,
 * confidence is low and the result says so first: the weak matches it shows are there to be
 * checked. A result that shows nothing is the nothing-found reply.
 */
export async function searchFacts(
  ports: CorePorts,
  ctx: Asker,
  input: SearchFactsInput,
): Promise<SearchOutcome> {
  if (input.id !== undefined && input.id.trim() !== "") return byId(ports, ctx, input.id);
  const text = input.query?.trim() ?? "";
  if (text === "") {
    throw invalidInput("search_facts needs a query or an id.", "Pass your question as `query`.");
  }
  const ranking = await rankFacts(ports, ctx, text, input.limit);
  const facts = await factViews(ports, ctx.caller, ranking.facts);
  const { confidence } = ranking.verdict;
  const lead =
    facts.length === 0
      ? NOTHING_FOUND
      : confidence === "low"
        ? noConfidentMatch(facts.length)
        : undefined;
  return {
    matched: ranking.matched,
    shown: facts.length,
    confidence,
    facts,
    degraded: ranking.degraded,
    ...(lead === undefined ? {} : { message: lead }),
    ...(input.explain === true ? { explain: explanation(ranking, facts.length) } : {}),
  };
}
