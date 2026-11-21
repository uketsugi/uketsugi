/**
 * A run of the suite: the cases of every item and configuration (a treatment `repeat` times, and a
 * control once), up to `jobs` at a time, each with its own server, store, trees and ports; then the
 * result assembled and the headline printed first.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, AdapterContext } from "./adapter.ts";
import { type Prepared } from "./prepare.ts";
import type { Tools } from "./preflight.ts";
import type { Scoring } from "./evidence.ts";
import { sessionCount } from "./plan.ts";
import { evidence, headline, table, compare, type Result } from "./report.ts";
import { assemble, readResultFile } from "./results.ts";
import { runCase, type Job, type Suite } from "./runner.ts";
import type { Items } from "./items.ts";

export interface RunOptions {
  readonly adapter: Adapter;
  readonly configs: readonly string[];
  readonly items: readonly string[];
  readonly mode: "quick" | "full";
  readonly gap: number;
  readonly repeat: number;
  /** The number of the first repeat: a later round of the same arm is numbered on from the earlier. */
  readonly repeatFrom: number;
  /** Whether each item's control is run (it is run once, in the arm's first round). */
  readonly control: boolean;
  readonly jobs: number;
  readonly out: string;
  readonly compare?: string;
}

export function jobsOf(options: RunOptions): Job[] {
  const treatments = Array.from({ length: options.repeat }, (_, n) =>
    options.configs.flatMap((config) =>
      options.items.map((item) => ({
        config,
        item,
        kind: "treatment" as const,
        repeat: options.repeatFrom + n,
      })),
    ),
  ).flat();
  const controls = options.control
    ? options.configs.flatMap((config) =>
        options.items.map((item) => ({ config, item, kind: "control" as const, repeat: 0 })),
      )
    : [];
  return [...treatments, ...controls];
}

/** Runs `work` over `items`, at most `width` at a time, keeping the order of the results. */
async function pool<T, R>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) results[i] = await work(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
}

export async function runSuite(
  options: RunOptions,
  prepared: Prepared,
  context: AdapterContext,
  tools: Tools,
  items: Items,
  scoring: Scoring,
): Promise<Result> {
  const suite: Suite = {
    adapter: options.adapter,
    adapterContext: context,
    tools,
    chain: prepared.chain,
    rebuilt: prepared.rebuilt,
    items,
    judge: prepared.judge,
    scoring,
    gap: options.gap,
    resultsDir: options.out,
  };
  await mkdir(join(options.out, "cases"), { recursive: true });
  const jobs = jobsOf(options);
  const planned =
    sessionCount(
      items,
      prepared.chain,
      options.items,
      options.gap,
      options.repeat,
      options.control,
    ) * options.configs.length;
  console.log(`planned: ${jobs.length} cases, about ${planned} sessions (a report, not a cap)`);
  const started = Date.now();
  const records = await pool(jobs, options.jobs, (job) => runCase(suite, job));
  const settings = {
    product: options.adapter.name,
    configs: options.configs,
    model: context.model,
    mode: options.mode,
    shape: "cases",
    gap: options.gap,
    repeat: options.repeat,
    uketsugi: { build: prepared.build },
    minutes: Math.round((Date.now() - started) / 6000) / 10,
  };
  return assemble(settings, records);
}

/** Prints the headline first, then the table, the totals, the evidence and the comparison; writes `result.json`. */
export async function report(
  result: Result,
  items: Items,
  out: string,
  against?: string,
): Promise<void> {
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 1));
  console.log(headline(result));
  console.log(table(result, items));
  console.log(JSON.stringify(result.totals, null, 1));
  console.log(evidence(result));
  console.log(`result: ${join(out, "result.json")}`);
  if (against !== undefined)
    console.log(`\nagainst ${against}:\n${compare(await readResultFile(against), result)}`);
}
