/**
 * The replay: each kept case's facts are published, in the order they were written, into a project
 * of the product's own server; the follow-up jobs run; the first query of each probe cell is
 * searched as an agent searches; and the place of the fact that states the item is read. A cell
 * whose needed fact is not in the top 10 is looked into (`causes.ts`).
 */
import type { SearchFactsResult } from "@uketsugi/contracts";
import type { ToolCaller } from "@uketsugi/testkit";
import { briefHolds, type BriefHold } from "./brief.ts";
import { explainMiss, type Miss } from "./causes.ts";
import {
  citationOf,
  scorable,
  type Label,
  type ReplayCase,
  type ReplayFact,
  type Shape,
} from "./data.ts";
import { SEARCH_LIMIT, searchExplained, type ReplayEnv } from "./env.ts";
import { VARIANTS, withRelaxed } from "./profile.ts";

export type Arm = "words" | "model";

/**
 * The order facts are published in. `written` is the order they were written in (a fact's id, a
 * UUIDv7, says when). `listed` is the order the data file lists them in, newest first, which is how
 * memory research's round 3 scripts published them.
 */
export type Order = "written" | "listed";

export interface CellRow {
  readonly shape: Shape;
  readonly arm: Arm;
  readonly case: string;
  readonly item: string;
  readonly task: string;
  readonly query: string;
  /** The place of the best needed fact among the 50 shown; null when none is. */
  readonly place: number | null;
  readonly confidence: SearchFactsResult["confidence"];
  readonly matched: number;
  readonly brief: BriefHold;
  readonly miss: Miss | null;
  /** The place of the needed fact when each fitted value is relaxed in turn; null when not in the 50 shown. */
  readonly relaxed: Readonly<Record<string, number | null>>;
}

const TOP = 10;

/** Publishes the facts in order and returns each one's id in the store, with the needed ones' live ids. */
async function publishCase(
  env: ReplayEnv,
  project: string,
  entry: ReplayCase,
  order: Order,
): Promise<{ targets: Map<string, ReplayFact> }> {
  const writer = env.caller(project, "replay-writer");
  const stored = new Map<string, string>();
  const facts =
    order === "listed" ? entry.facts : [...entry.facts].sort((a, b) => a.id.localeCompare(b.id));
  for (const fact of facts) {
    const args: Record<string, unknown> = {
      claim: fact.claim,
      citations: fact.citations.length > 0 ? fact.citations.map(citationOf) : ["replay"],
      ...(fact.detail === null ? {} : { detail: fact.detail }),
      ...(fact.question === null ? {} : { question: fact.question }),
    };
    stored.set(fact.id, (await writer("publish_fact", args)).id);
  }
  await env.drain();
  if (env.model) await requireVectors(env, [...new Set(stored.values())]);
  const targets = new Map<string, ReplayFact>();
  for (const fact of entry.facts.filter((f) => entry.targets.has(f.id))) {
    // A fact that a later one superseded is searched under its live head.
    const found = await writer("search_facts", { id: stored.get(fact.id) });
    const head = found.facts[found.facts.length - 1];
    targets.set(head?.id ?? stored.get(fact.id) ?? fact.id, fact);
  }
  return { targets };
}

/** Throws when a fact has no vector: an arm "with the model" would then be partly word-only. */
async function requireVectors(env: ReplayEnv, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const fact = await env.ports.store.facts.get(env.scope, id);
    if (fact !== null && fact.status !== "superseded" && !fact.embedded) {
      throw new Error(`fact ${id} was left without a vector: the run is void`);
    }
  }
}

/** The arm's own mark: with the model no search is degraded; with none every one says `no_model`. */
function requireArm(env: ReplayEnv, found: SearchFactsResult, query: string): void {
  const degraded = found.degraded.join();
  const wanted = env.model ? "" : "no_model";
  if (degraded !== wanted) {
    throw new Error(
      `the run is void: a search of "${query.slice(0, 50)}" was degraded [${degraded}], the arm expects [${wanted}]`,
    );
  }
}

/** The place of the best needed fact in a search's 50 shown, or null. */
async function placeOf(
  call: ToolCaller,
  query: string,
  targets: ReadonlyMap<string, ReplayFact>,
): Promise<number | null> {
  const found = await call("search_facts", { query, limit: SEARCH_LIMIT });
  const index = found.facts.findIndex((fact) => targets.has(fact.id));
  return index === -1 ? null : index + 1;
}

/** The rows again, each with the places the cells take when one fitted value is relaxed at a time. */
async function withRelaxedPlaces(
  env: ReplayEnv,
  reader: ToolCaller,
  targets: ReadonlyMap<string, ReplayFact>,
  rows: readonly CellRow[],
): Promise<CellRow[]> {
  const places: Record<string, number | null>[] = rows.map(() => ({}));
  for (const variant of VARIANTS) {
    if (!env.model && variant === "vectorCutoff") continue;
    await withRelaxed(variant, async () => {
      for (const [index, row] of rows.entries()) {
        const own = places[index];
        if (own !== undefined) own[variant] = await placeOf(reader, row.query, targets);
      }
    });
  }
  return rows.map((row, index) => ({ ...row, relaxed: places[index] ?? {} }));
}

/** Replays one case; returns a row per cell that has a query. */
export async function replayCase(
  env: ReplayEnv,
  shape: Shape,
  entry: ReplayCase,
  labels: ReadonlyMap<string, Label>,
  order: Order,
): Promise<CellRow[]> {
  const project = `github.com/replay/${entry.case.toLowerCase()}`;
  const { targets } = await publishCase(env, project, entry, order);
  const reader = env.caller(project, "replay-reader");
  const arm: Arm = env.model ? "model" : "words";
  const rows: CellRow[] = [];
  let brief: BriefHold | null = null;
  for (const cell of entry.cells) {
    const first = cell.queries[0];
    if (first === undefined) continue;
    const found = await searchExplained(reader, first.query);
    requireArm(env, found, first.query);
    brief ??= briefHolds(found, targets, labels);
    const index = found.facts.findIndex((fact) => targets.has(fact.id));
    const place = index === -1 ? null : index + 1;
    const missed = place === null || place > TOP;
    const miss = missed
      ? await explainMiss({
          env,
          call: reader,
          query: first.query,
          found,
          targets,
          corpus: entry.facts,
        })
      : null;
    rows.push({
      shape,
      arm,
      case: entry.case,
      item: entry.item,
      task: cell.task,
      query: first.query,
      place,
      confidence: found.confidence,
      matched: found.matched,
      brief,
      miss,
      relaxed: {},
    });
  }
  return await withRelaxedPlaces(env, reader, targets, rows);
}

/** What a brief-only run keeps of a cell: the brief its session was handed. */
export type BriefRow = Pick<CellRow, "shape" | "case" | "item" | "task" | "brief">;

/**
 * The briefs alone: each case is published and its reader's first search carries the brief, which
 * every cell of the case shares. No cell is searched for its place, explained or relaxed, which is
 * where a full run spends its time; the brief does not depend on the arm.
 */
export async function replayBriefs(
  env: ReplayEnv,
  shape: Shape,
  cases: readonly ReplayCase[],
  labels: ReadonlyMap<string, Label>,
  order: Order = "written",
): Promise<BriefRow[]> {
  const rows: BriefRow[] = [];
  for (const entry of scorable(cases)) {
    const project = `github.com/replay/${entry.case.toLowerCase()}`;
    const { targets } = await publishCase(env, project, entry, order);
    const first = entry.cells.find((cell) => cell.queries[0] !== undefined);
    if (first?.queries[0] === undefined) continue;
    const found = await searchExplained(
      env.caller(project, "replay-reader"),
      first.queries[0].query,
    );
    const brief = briefHolds(found, targets, labels);
    for (const cell of entry.cells.filter((c) => c.queries[0] !== undefined)) {
      rows.push({ shape, case: entry.case, item: entry.item, task: cell.task, brief });
    }
  }
  return rows;
}

/** Replays every scorable case of a shape in one server. */
export async function replayShape(
  env: ReplayEnv,
  shape: Shape,
  cases: readonly ReplayCase[],
  labels: ReadonlyMap<string, Label>,
  order: Order = "written",
): Promise<CellRow[]> {
  const rows: CellRow[] = [];
  for (const entry of scorable(cases)) {
    rows.push(...(await replayCase(env, shape, entry, labels, order)));
  }
  return rows;
}
