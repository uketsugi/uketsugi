/**
 * How runs add up, set before any run. The manifest of a run (the chain data and wording, the items
 * and patterns, the live shape's code, the configuration, the model id and the harness's minor
 * version) is frozen and hashed before its first session; runs pool when their hashes are equal.
 * A pooled claim is about one build of the product: runs pool for the claims only when the manifest hash and the build are both equal (this departs from design section 5, where builds pooled and were listed). The flag compares with every earlier run of the manifest, of any build, and says which.
 * The claim tests run once each, on the first pooled units: the deciding item tests and the task
 * passes at 16 units, later-session cost at 32; no claim is made at any other size. Each run on its
 * own is descriptive, with a regression flag: its deciding tests with memory and its stored count
 * against the pool before it, by an exact Fisher test at 0.05.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fisherExact, mcnemarExact } from "./exact.ts";
import { LATER } from "./pair.ts";
import { figuresOf, laterCost } from "./report.ts";
import { ITEMS } from "./data.ts";
import { DECIDING, type RunMeta, type UnitScore } from "./score.ts";

export const ITEM_CLAIM_UNITS = 16;
export const COST_CLAIM_UNITS = 32;
const LEVEL = 0.05;

export interface ManifestInput {
  /** Folders whose files are the run's data and code: every `.json`, `.jsonl`, `.ts` and `.py` in them is hashed. */
  readonly folders: readonly string[];
  readonly config: string;
  readonly model: string;
  /** The harness's version as it reports it; only its major and minor count. */
  readonly harness: string;
}

export const harnessMinor = (version: string): string => /\d+\.\d+/.exec(version)?.[0] ?? version;

async function filesOf(folder: string): Promise<string[]> {
  const names = await readdir(folder, { recursive: true });
  return names.filter((n) => /\.(json|jsonl|ts|py)$/.test(n)).sort();
}

/** The manifest, and its hash: the same inputs give the same hash. */
export async function manifestOf(
  input: ManifestInput,
): Promise<{ manifest: unknown; hash: string }> {
  const files: Record<string, string> = {};
  for (const folder of input.folders) {
    for (const name of await filesOf(folder)) {
      const data = await readFile(join(folder, name)).catch(() => undefined);
      if (data !== undefined)
        files[`${folder.split("/").slice(-2).join("/")}/${name}`] = createHash("sha256")
          .update(data)
          .digest("hex");
    }
  }
  const manifest = {
    files,
    config: input.config,
    model: input.model,
    harness: harnessMinor(input.harness),
  };
  return {
    manifest,
    hash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 16),
  };
}

/** Writes `manifest.json` into the run's folder, before its first session. */
export async function freeze(folder: string, input: ManifestInput): Promise<string> {
  const { manifest, hash } = await manifestOf(input);
  await writeFile(
    join(folder, "manifest.json"),
    JSON.stringify({ hash, ...(manifest as object) }, null, 1),
  );
  return hash;
}

export interface ScoredRun {
  readonly meta: RunMeta;
  readonly units: readonly UnitScore[];
}

const decidingCells = (units: readonly UnitScore[], arm: "memory" | "none"): boolean[] =>
  units.flatMap((u) =>
    DECIDING.map((i) => LATER.some((t) => u.arms[arm].later[t]?.tests[i] === true)),
  );

const passCells = (units: readonly UnitScore[], arm: "memory" | "none"): boolean[] =>
  units.flatMap((u) => LATER.map((t) => u.arms[arm].later[t]?.passed === true));

/** McNemar's exact test over cells paired memory against none. */
function paired(
  memory: readonly boolean[],
  none: readonly boolean[],
): { b: number; c: number; p: number } {
  const b = memory.filter((m, i) => m && !none[i]).length;
  const c = memory.filter((m, i) => !m && none[i]).length;
  return { b, c, p: mcnemarExact(b, c) };
}

const fixed = (p: number): string => p.toFixed(3);

/** The claim at 16 units: deciding item tests and task passes, once, on the first 16 pooled units. */
function itemClaim(units: readonly UnitScore[], finishedBy: string): string {
  if (units.length < ITEM_CLAIM_UNITS)
    return `Item and task claim: ${units.length} of ${ITEM_CLAIM_UNITS} pooled units; not made yet.`;
  const first = units.slice(0, ITEM_CLAIM_UNITS);
  const items = paired(decidingCells(first, "memory"), decidingCells(first, "none"));
  const tasks = paired(passCells(first, "memory"), passCells(first, "none"));
  return `Item and task claim, made once at ${ITEM_CLAIM_UNITS} pooled units (completed by ${finishedBy}): deciding item tests memory-only ${items.b}, none-only ${items.c}, p ${fixed(items.p)}; task passes memory-only ${tasks.b}, none-only ${tasks.c}, p ${fixed(tasks.p)}.`;
}

/** The claim at 32 units: later-session cost, once, unless more than 1 in 10 later sessions of an arm is capped. */
function costClaim(units: readonly UnitScore[], finishedBy: string): string {
  if (units.length < COST_CLAIM_UNITS)
    return `Cost claim: ${units.length} of ${COST_CLAIM_UNITS} pooled units; not made yet.`;
  const first = units.slice(0, COST_CLAIM_UNITS);
  const cost = laterCost(first);
  if (cost.censored)
    return `Cost claim at ${COST_CLAIM_UNITS} pooled units (completed by ${finishedBy}): censored, over 1 in 10 later sessions of an arm are capped; no test.`;
  return `Cost claim, made once at ${COST_CLAIM_UNITS} pooled units (completed by ${finishedBy}): later sessions ${cost.memory.toFixed(0)} vs ${cost.none.toFixed(0)} tokens, exact Wilcoxon p ${fixed(cost.p ?? 1)}.`;
}

const rate = (hits: number, of: number): string => `${hits}/${of}`;

/** The run's deciding tests with memory and its stored count against the pool before it. */
export function regression(run: ScoredRun, before: readonly ScoredRun[]): string {
  const prior = before.flatMap((r) => r.units).filter((u) => !u.void);
  if (prior.length === 0) return "Regression flag: no pool before this run.";
  const builds = [...new Set(before.map((r) => r.meta.build))].join(", ");
  const now = run.units.filter((u) => !u.void);
  const tests = (us: readonly UnitScore[]): number =>
    decidingCells(us, "memory").filter(Boolean).length;
  const stored = (us: readonly UnitScore[]): number =>
    us.flatMap((u) => ITEMS.map((i) => u.arms.memory.stored[i] === true)).filter(Boolean).length;
  const measures = [
    {
      name: "deciding tests with memory",
      a: tests(now),
      n: now.length * DECIDING.length,
      b: tests(prior),
      m: prior.length * DECIDING.length,
    },
    {
      name: "stored",
      a: stored(now),
      n: now.length * ITEMS.length,
      b: stored(prior),
      m: prior.length * ITEMS.length,
    },
  ].map((x) => {
    const p = fisherExact(x.a, x.n - x.a, x.b, x.m - x.b);
    const flag =
      p >= LEVEL ? "no flag" : x.a / x.n < x.b / x.m ? "REGRESSION" : "higher than the pool";
    return `${x.name} ${rate(x.a, x.n)} against the pool's ${rate(x.b, x.m)}: Fisher p ${fixed(p)}, ${flag}`;
  });
  return `Regression flag against builds ${builds} (cells are counted as independent, which they are not quite; read it as a prompt to look): ${measures.join("; ")}.`;
}

/**
 * The comparison with the pool: the runs before this one whose manifest hash is equal pool with it;
 * the others are listed as not pooled. The claim tests are read off the pooled units in order.
 */
export function poolSection(run: ScoredRun, earlier: readonly ScoredRun[]): string {
  const equal = earlier.filter((r) => r.meta.hash === run.meta.hash);
  const apart = earlier.filter((r) => r.meta.hash !== run.meta.hash);
  const voided = equal.flatMap((r) => {
    const why = figuresOf(r.units).runVoid;
    return why === null ? [] : [{ r, why }];
  });
  const same = equal.filter((r) => !voided.some((v) => v.r === r));
  const selfVoid = figuresOf(run.units).runVoid;
  const sameBuild = same.filter((r) => r.meta.build === run.meta.build);
  const runs = selfVoid === null ? [...same.filter((r) => sameBuild.includes(r)), run] : sameBuild;
  let units: UnitScore[] = [];
  const finishers: string[] = [];
  for (const r of runs) {
    for (const u of r.units.filter((x) => !x.void)) {
      units = [...units, u];
      finishers.push(r.meta.build);
    }
  }
  const lines = [
    `Pool: manifest ${run.meta.hash}; ${runs.length} runs, ${units.length} units pooled; build ${run.meta.build}.`,
    ...apart.map((r) => `Not pooled: ${r.meta.build} has manifest ${r.meta.hash}.`),
    ...same
      .filter((r) => !sameBuild.includes(r))
      .map(
        (r) =>
          `Not pooled for the claims: ${r.meta.build} is another build than ${run.meta.build} (the regression flag still compares with it).`,
      ),
    ...voided.map((v) => `Left out, void: ${v.r.meta.build} (${v.why}).`),
    ...(selfVoid === null ? [] : [`This run is void (${selfVoid}) and is not pooled.`]),
    itemClaim(units, finishers[ITEM_CLAIM_UNITS - 1] ?? "-"),
    costClaim(units, finishers[COST_CLAIM_UNITS - 1] ?? "-"),
    regression(run, same),
  ];
  return lines.join("\n");
}
