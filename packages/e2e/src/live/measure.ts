/**
 * `live --measure <run folder>[,<run folder>...] --out <file>`: the times a run's folder shows (a
 * dry run's, or a real run's), joined into the file a run's schedule is worked out from. Folders
 * of different widths are joined: the run picks the narrowest that covers its units.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { joined, measuredFrom, type MeasuredSet } from "./fit.ts";
import type { RunFile } from "./score.ts";

export async function measureRuns(folders: readonly string[], out: string): Promise<MeasuredSet> {
  const runs = await Promise.all(
    folders.map(async (f) => JSON.parse(await readFile(join(f, "run.json"), "utf8")) as RunFile),
  );
  const set = joined(runs.map((r) => measuredFrom(r)));
  await writeFile(out, JSON.stringify(set, null, 1));
  return set;
}

export async function readMeasured(path: string | undefined): Promise<MeasuredSet> {
  if (path === undefined)
    throw new Error(
      "pass --measured <file>: this machine's measured times, made by `live --measure <run folder of a dry run>`; a run does not start without the arithmetic of its hour",
    );
  const text = await readFile(path, "utf8").catch(() => {
    throw new Error(
      `no measured times at ${path}: run \`live --dry-run\`, then \`live --measure\``,
    );
  });
  return JSON.parse(text) as MeasuredSet;
}
