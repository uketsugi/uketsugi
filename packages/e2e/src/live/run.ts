/**
 * A live run from its units to its printed result: the units run in both arms (`pair.ts`) on a host,
 * `run.json` is written beside the cases' evidence, and the run is scored from that evidence with
 * the same code that rescoring uses (`score.ts`, `report.ts`, `pool.ts`), so that what a run prints
 * and what `--rescore` prints are one.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Guard } from "../recall/quota.ts";
import { runPairs, type Host, type UnitRecord } from "./pair.ts";
import { poolSection } from "./pool.ts";
import { proofsOf } from "./proofs.ts";
import { render } from "./report.ts";
import { scoreRun, type RunFile, type Scoring } from "./score.ts";

export interface RunOptions {
  readonly units: number;
  readonly guard: Guard;
  /** Folder for the sessions' homes, trees and stores. */
  readonly work: string;
  readonly out: string;
  readonly build: string;
  readonly config: string;
  readonly model: string;
  /** The frozen manifest's hash, written to `manifest.json` before the first session. */
  readonly hash: string;
  /** Earlier runs' folders, for the comparison with the pool. */
  readonly pool: readonly string[];
  readonly scoring: Scoring;
  /** The harness's version, read from the host once its sessions have run. */
  readonly harness: () => string;
}

export async function writeRunFile(out: string, run: RunFile): Promise<void> {
  await writeFile(join(out, "run.json"), JSON.stringify(run, null, 1));
}

/** Runs the units, writes the run, scores it, and returns what is printed. */
export async function runUnits(host: Host, options: RunOptions): Promise<string> {
  if (!existsSync(join(options.out, "manifest.json")))
    throw new Error(
      "the manifest is not frozen: it is written, with its hash, before the first session",
    );
  const units: UnitRecord[] = await runPairs({
    units: options.units,
    host,
    guard: options.guard,
    work: options.work,
  });
  const file = {
    build: options.build,
    config: options.config,
    model: options.model,
    harness: options.harness(),
    hash: options.hash,
    minutes: host.now() / 60_000,
    units,
  };
  await writeRunFile(options.out, file);
  const failed = await proofsOf(options.out, file);
  const scored = await scoreRun(options.out, options.scoring);
  const earlier = await Promise.all(
    options.pool.map((folder) => scoreRun(folder, options.scoring)),
  );
  const body = render(scored.meta, scored.units, poolSection(scored, earlier));
  const text = failed.length === 0 ? body : `VOID (a proof failed: ${failed.join("; ")}) · ${body}`;
  await writeFile(join(options.out, "report.txt"), text + "\n");
  return text;
}
