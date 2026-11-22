/**
 * Hand labels of the facts a run's earlier sessions stored. A pattern is a first pass and cannot be
 * the last word on "stored": a model writes a fact in words no pattern foresaw. Where a run's stored
 * facts have been labelled by reading them, the labels decide which item each fact states, and the
 * patterns decide nothing for that run. The file is `<run folder>/labels.json`:
 *
 *   { "items": ["P1", "D2", "D1", "D3", "D8"],
 *     "records": [ { "unit": 1, "fact": "<the fact's id in the store>", "states": ["P1"], "why": "..." } ] }
 *
 * It must name every fact of every unit's store once, and nothing else; `states` is the items the
 * fact states (none when it states none), `why` says why.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoreFact } from "../recall/adapter.ts";
import { ITEMS } from "./data.ts";

export interface LabelRecord {
  readonly unit: number;
  readonly fact: string;
  readonly states: readonly string[];
  readonly why: string;
}

export interface Labels {
  readonly items: readonly string[];
  readonly records: readonly LabelRecord[];
}

export async function readLabels(folder: string): Promise<Labels | undefined> {
  const path = join(folder, "labels.json");
  return existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as Labels) : undefined;
}

/** What is wrong with the labels against the stores they label, in words; empty when they fit. */
export function labelProblems(
  labels: Labels,
  stores: Readonly<Record<number, readonly StoreFact[]>>,
): string[] {
  const problems: string[] = [];
  if ([...labels.items].sort().join() !== [...ITEMS].sort().join())
    problems.push(`items must be exactly ${ITEMS.join(", ")}`);
  const seen = new Set<string>();
  for (const r of labels.records) {
    const key = `${r.unit}/${r.fact}`;
    const store = stores[r.unit];
    if (store === undefined) problems.push(`unit ${r.unit} is not in the run`);
    else if (!store.some((f) => f.id === r.fact))
      problems.push(`${key}: the run's store of unit ${r.unit} holds no such fact`);
    if (seen.has(key)) problems.push(`${key}: labelled twice`);
    seen.add(key);
    for (const s of r.states) if (!ITEMS.includes(s)) problems.push(`${key}: ${s} is not an item`);
    if (r.why.trim() === "") problems.push(`${key}: no reason given`);
  }
  for (const [unit, store] of Object.entries(stores))
    for (const f of store)
      if (!seen.has(`${unit}/${f.id}`))
        problems.push(`${unit}/${f.id}: a stored fact with no label`);
  return problems;
}

/** The facts of one unit's store that the labels say state `item`. */
export function factsStating(
  labels: Labels,
  unit: number,
  store: readonly StoreFact[],
  item: string,
): StoreFact[] {
  const ids = new Set(
    labels.records.filter((r) => r.unit === unit && r.states.includes(item)).map((r) => r.fact),
  );
  return store.filter((f) => ids.has(f.id));
}
