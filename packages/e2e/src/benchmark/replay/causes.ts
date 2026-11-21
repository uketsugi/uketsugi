/**
 * Why a probe's needed fact did not come back in the top 10, as one of three causes:
 * `query` (no pass admits the fact, however the fitted values are set: the query does not name it),
 * `outranked` (admitted by a pass and standing, below ten others), `value` (a fitted value shuts it
 * out: the store admits it when that value is relaxed, or the keyword floor drops it). The control
 * asks the same store with the fact's own claim as the query.
 *
 * It reads the product's search the way the search does: the store's own statements, with the values
 * the result's explanation names. The one rule restated is the keyword floor, because core does not
 * export it; `floorFails` is checked against the results in `replay.test.ts`.
 */
import type { SearchFactsResult } from "@uketsugi/contracts";
import type { CandidateRow, PassRow, SearchQuery } from "@uketsugi/core";
import type { ReplayEnv } from "./env.ts";
import { SEARCH_LIMIT } from "./env.ts";
import type { ReplayFact } from "./data.ts";
import { namingOf, type Naming } from "./naming.ts";

type Explain = {
  query: { identifiers: string[] };
  profile: Record<string, number>;
  candidates: { id: string; ranks: Record<string, number> }[];
};

export interface Above {
  readonly claim: string;
  readonly ranks: Readonly<Record<string, number>>;
}

export interface Miss {
  readonly cause: "query" | "outranked" | "value";
  /** For `value`: the fitted values whose relaxing admits the fact. */
  readonly values: readonly string[];
  /** Whether the query shares a specific word with the fact, apart from the cause (see `naming.ts`). */
  readonly naming: Naming;
  /** For `outranked`: the place when within the 50 shown, else null; the pass ranks and evidence. */
  readonly place: number | null;
  readonly ranks: Readonly<Record<string, number>>;
  readonly cosine: number | null;
  readonly coverage: number | null;
  /** What stands at the head of the order. */
  readonly above: readonly Above[];
  /** The place of the needed fact when its own claim is the query; null when not in the top 50. */
  readonly control: number | null;
}

/** What a probe needs of the case to look into its miss. */
export interface MissContext {
  readonly env: ReplayEnv;
  readonly call: (
    tool: "search_facts",
    args: Record<string, unknown>,
  ) => Promise<SearchFactsResult>;
  readonly query: string;
  readonly found: SearchFactsResult;
  /** The needed facts, by their id in the store. */
  readonly targets: ReadonlyMap<string, ReplayFact>;
  /** Every fact of the case's store: what makes a word generic. */
  readonly corpus: readonly ReplayFact[];
}

/** The relaxations tried one at a time, each named for the fitted value it sets aside. */
const RELAXED: Record<string, Partial<SearchQuery>> = {
  coverageAdmission: { admissionCoverage: 0 },
  vectorCutoff: { vectorCutoff: -1 },
  trigramThreshold: { trigramThreshold: 0 },
  passLimit: { passLimit: 100_000 },
};

interface Kept {
  readonly ranks: Map<string, Record<string, number>>;
  readonly rows: Map<string, CandidateRow>;
}

/** The passes' candidates, as core gathers them for a search. */
async function keptBy(env: ReplayEnv, query: SearchQuery): Promise<Kept> {
  const { search } = env.ports.store;
  const passes = await search.passes(query);
  const ids = [...new Set(passes.map((row) => row.factId))];
  const [near, rows] = await Promise.all([
    search.trigram(query, ids),
    search.candidates(query, ids),
  ]);
  const ranks = new Map<string, Record<string, number>>();
  for (const row of [...passes, ...near] as PassRow[]) {
    ranks.set(row.factId, { ...ranks.get(row.factId), [row.pass]: row.rank });
  }
  return { ranks, rows: new Map(rows.map((row) => [row.factId, row])) };
}

/** Whether the keyword floor drops a candidate: wording alone found it, and it is far and thin. */
export function floorFails(
  ranks: Readonly<Record<string, number>>,
  cosine: number | null,
  coverage: number,
  profile: Readonly<Record<string, number>>,
): boolean {
  if (ranks["identifier"] !== undefined || ranks["vector"] !== undefined) return false;
  if (cosine === null || cosine >= (profile["vectorCutoff"] ?? 0)) return false;
  return coverage < (profile["keywordFloor"] ?? 0);
}

/** The best place any needed fact takes when its own claim is asked. */
async function controlPlace(context: MissContext): Promise<number | null> {
  const places: number[] = [];
  for (const target of context.targets.values()) {
    const found = await context.call("search_facts", { query: target.claim, limit: SEARCH_LIMIT });
    const index = found.facts.findIndex((fact) => context.targets.has(fact.id));
    if (index !== -1) places.push(index + 1);
  }
  return places.length === 0 ? null : Math.min(...places);
}

function aboveOf(context: MissContext): Above[] {
  const explain = context.found.explain as Explain | undefined;
  return context.found.facts.slice(0, 2).map((fact) => ({
    claim: fact.claim,
    ranks: explain?.candidates.find((entry) => entry.id === fact.id)?.ranks ?? {},
  }));
}

const NONE = {
  values: [],
  place: null,
  ranks: {},
  cosine: null,
  coverage: null,
};

/** The search the product ran for this query, rebuilt from the values its explanation names. */
async function queryOf(context: MissContext): Promise<SearchQuery> {
  const { env, found, query } = context;
  const explain = found.explain as Explain;
  const { profile } = explain;
  const { embedder } = env.ports;
  const embedded = embedder === null ? null : await embedder.embed([query], "query");
  return {
    scope: env.scope,
    project: found.project,
    query,
    idents: explain.query.identifiers,
    embedding:
      embedder === null || embedded?.[0] === undefined
        ? null
        : { model: embedder.model, vector: embedded[0] },
    vectorCutoff: profile["vectorCutoff"] ?? 0,
    admissionCoverage: profile["coverageAdmission"] ?? 0,
    trigramThreshold: profile["trigramThreshold"] ?? 0,
    passLimit: profile["passLimit"] ?? 0,
  };
}

/** A needed fact the passes kept but the first ten do not hold: below others, or dropped by the floor. */
function keptMiss(context: MissContext, kept: Kept, own: string, rest: Evidence): Miss {
  const { found } = context;
  const { profile } = found.explain as Explain;
  const ranks = kept.ranks.get(own) ?? {};
  const row = kept.rows.get(own);
  const cosine = row?.cosine ?? null;
  const coverage = row?.lexemeCoverage ?? 0;
  const shown = found.facts.findIndex((fact) => fact.id === own);
  const floor = floorFails(ranks, cosine, coverage, profile);
  if (shown !== -1 && floor) {
    throw new Error("the keyword floor as restated here drops a fact the product shows");
  }
  const evidence = { ...NONE, ...rest, ranks, cosine, coverage };
  if (shown === -1 && floor) return { ...evidence, cause: "value", values: ["keywordFloor"] };
  return { ...evidence, cause: "outranked", place: shown === -1 ? null : shown + 1 };
}

/** The fitted values whose relaxing makes the passes keep a needed fact. */
async function shutOutBy(context: MissContext, base: SearchQuery): Promise<string[]> {
  const values: string[] = [];
  for (const [name, change] of Object.entries(RELAXED)) {
    if (base.embedding === null && name === "vectorCutoff") continue;
    const relaxed = await keptBy(context.env, { ...base, ...change });
    if ([...context.targets.keys()].some((id) => relaxed.ranks.has(id))) values.push(name);
  }
  return values;
}

type Evidence = Pick<Miss, "above" | "control" | "naming">;

/** Classifies one miss. `context.found` is the search that missed, with its explanation. */
export async function explainMiss(context: MissContext): Promise<Miss> {
  const base = await queryOf(context);
  const rest: Evidence = {
    above: aboveOf(context),
    control: await controlPlace(context),
    naming: namingOf(context.query, context.targets.values(), context.corpus),
  };
  const kept = await keptBy(context.env, base);
  const ids = [...context.targets.keys()];
  const shownAt = ids
    .map((id) => context.found.facts.findIndex((fact) => fact.id === id))
    .filter((index) => index !== -1)
    .sort((a, b) => a - b)[0];
  const own =
    shownAt === undefined ? ids.find((id) => kept.ranks.has(id)) : context.found.facts[shownAt]?.id;
  if (own !== undefined) return keptMiss(context, kept, own, rest);
  const values = await shutOutBy(context, base);
  if (values.length > 0) return { ...NONE, ...rest, cause: "value", values };
  return { ...NONE, ...rest, cause: "query" };
}
