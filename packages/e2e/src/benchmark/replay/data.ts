/**
 * The replay's data: kept recall probes, as files outside the repository. `labels.json` says which
 * facts state each item, made by reading them (never by a pattern); `own.json` and `project.json`
 * hold the stores of two shapes (each case's own, and one project's history), each case's facts in
 * the order they were written and its probe cells' queries.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ReplayFact {
  readonly id: string;
  readonly claim: string;
  readonly detail: string | null;
  readonly question: string | null;
  readonly citations: readonly string[];
  /** Written before the session began, not by the probe's own session. */
  readonly seed: boolean;
}

/** One probe cell: the queries its agent sent before its first write. Only the first is scored. */
export interface ReplayCell {
  readonly task: string;
  readonly session: string;
  readonly queries: readonly { readonly query: string; readonly confidence: string }[];
}

export interface ReplayCase {
  readonly case: string;
  readonly item: string;
  readonly facts: readonly ReplayFact[];
  readonly cells: readonly ReplayCell[];
  /** The ids of the facts a person reading them judged to state the item. */
  readonly targets: ReadonlySet<string>;
}

export type Shape = "own" | "project";
export const SHAPES: readonly Shape[] = ["own", "project"];

/** A read label: the item a fact states, and the words of it that must be in the fact (when recorded). */
export interface Label {
  readonly item: string;
  readonly stretch: string | null;
}

export interface ReplayData {
  readonly labels: ReadonlyMap<string, Label>;
  readonly shapes: Readonly<Record<Shape, readonly ReplayCase[]>>;
}

/** The label of a fact: labels are kept by the first 13 characters of its id. */
export function labelOf(labels: ReadonlyMap<string, Label>, factId: string): Label | undefined {
  return labels.get(factId.slice(0, 13));
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** What the replay needs from its data folder; each file named when absent. */
export function missingFiles(dir: string): string[] {
  const wanted = ["labels.json", ...SHAPES.map((shape) => `${shape}.json`)];
  return wanted.filter((name) => !existsSync(join(dir, name)));
}

interface RawCase extends Omit<ReplayCase, "targets"> {
  readonly facts: readonly ReplayFact[];
}

/** Reads the folder. Throws with the missing file's name when the data is absent. */
export function loadReplayData(dir: string): ReplayData {
  const missing = missingFiles(dir);
  if (missing.length > 0) {
    throw new Error(`the replay data is not in ${dir}: missing ${missing.join(", ")}`);
  }
  const labels = new Map(Object.entries(readJson<Record<string, Label>>(join(dir, "labels.json"))));
  const shapes = {} as Record<Shape, ReplayCase[]>;
  for (const shape of SHAPES) {
    const raw = readJson<{ cases: RawCase[] }>(join(dir, `${shape}.json`)).cases;
    shapes[shape] = raw.map((entry) => ({
      ...entry,
      targets: new Set(
        entry.facts
          .filter((fact) => !fact.seed && labelOf(labels, fact.id)?.item === entry.item)
          .map((fact) => fact.id),
      ),
    }));
  }
  return { labels, shapes };
}

/** The cases that hold a fact stating their item: the only ones a probe can be scored on. */
export function scorable(cases: readonly ReplayCase[]): ReplayCase[] {
  return cases.filter((entry) => entry.targets.size > 0);
}

/** The words a fact is judged by: its claim, then its detail. */
export function textOf(fact: ReplayFact): string {
  return `${fact.claim} ${fact.detail ?? ""}`;
}
