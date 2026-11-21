/**
 * The commands of `live` that start work: the run, `--prepare-only` (set-up with no task session,
 * timed), `--calibrate` and `--memcheck`. What every one needs is checked first and named when
 * missing; the run refuses before anything starts if it has no reading of the seven-day window.
 */
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext } from "../recall/adapter.ts";
import { adapterFor, configurationOf, DEFAULT_MODEL } from "../recall/adapters.ts";
import { Case } from "../recall/case.ts";
import { DATA } from "../recall/chain.ts";
import { loadItems } from "../recall/items.ts";
import { refuseBrokenPatterns } from "../recall/patterns.ts";
import { prepare, type Prepared } from "../recall/prepare.ts";
import { preflight, type Tools } from "../recall/preflight.ts";
import { run } from "../recall/process.ts";
import { Guard, lowerUnits, readingFromRun } from "../recall/quota.ts";
import { modelDirProblem } from "../recall/server.ts";
import { withWorkspace, type Workspace } from "../recall/workspace.ts";
import { calibrate } from "./calibrate.ts";
import { loadLiveChain } from "./data.ts";
import { LiveHost, type ArmProduct } from "./host.ts";
import { memcheck } from "./memcheck.ts";
import { MINUTE, type Arm } from "./pair.ts";
import { freeze } from "./pool.ts";
import { runUnits } from "./run.ts";
import { warmGoCache } from "./warm.ts";
import { none } from "../recall/none.ts";

/** The two arms a run builds: the memory arm's product as a person sets it up, and the arm with no product at all. */
export function armsOf(config: string): Record<Arm, ArmProduct> {
  return {
    memory: { adapter: adapterFor("uketsugi"), config },
    none: { adapter: none, config: "none" },
  };
}

/** What the frozen manifest covers: the chain's data, the live shape's code, and the shared code it runs on (judge, session, runner, harness driver). The build's commit is not in it: builds pool, and each is listed. */
export function manifestFolders(): string[] {
  return [DATA, import.meta.dirname, join(import.meta.dirname, "..", "recall")];
}

/** The tasks a run uses: only their trees are rebuilt and proved. */
export const USED_TASKS = ["T1", "T2", "T4", "T8"];
/** Set-up is meant to be done by minute 8; a run whose set-up is not done by minute 10 stops before any task session. */
export const SET_UP_TARGET_MS = 8 * MINUTE;
export const SET_UP_STOP_MS = 10 * MINUTE;

export interface Values {
  readonly ergo?: string;
  readonly config?: string;
  readonly model?: string;
  readonly units?: string;
  readonly out?: string;
  readonly "model-dir"?: string;
  readonly "reading-from"?: string;
  readonly width?: string;
  readonly pool?: string;
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");
const outOf = (values: Values, name: string): string =>
  values.out ?? join(tmpdir(), "ukt-live-results", `${stamp()}-${name}`);

/** What every command that starts sessions needs, with each missing piece named. */
async function machine(values: Values): Promise<{ tools: Tools; modelDir: string; model: string }> {
  const modelDir = values["model-dir"] ?? process.env["UKT_MODEL_DIR"];
  if (modelDir === undefined)
    throw new Error(
      "the embedding model: pass --model-dir or set UKT_MODEL_DIR (a directory `ukt setup` made)",
    );
  const problem = modelDirProblem(modelDir);
  if (problem !== undefined) throw new Error(`the embedding model: ${problem}`);
  return {
    tools: await preflight({ sessions: true }),
    modelDir,
    model: values.model ?? DEFAULT_MODEL,
  };
}

const ergoOf = (values: Values): string => {
  if (values.ergo === undefined)
    throw new Error("pass --ergo <a local mirror of ergo>: the run fetches nothing");
  return values.ergo;
};

/** Rebuilds and proves the trees the run uses, builds and installs the release (cached per commit), and warms the Go cache. */
async function setUp(workspace: Workspace, tools: Tools, values: Values) {
  const chain = await loadLiveChain();
  const releaseCache = join(tmpdir(), "ukt-live-release-cache");
  const prepared = await prepare(workspace, tools, chain, ergoOf(values), true, {
    tasks: USED_TASKS,
    releaseCache,
  });
  if (!prepared.verified)
    throw new Error(
      "the rebuilt chain is not proved: a task is not red at its parent and green at its squash",
    );
  const warmCache = await warmGoCache(prepared, tools, workspace);
  return { prepared, warmCache };
}

const contextOf = (
  workspace: Workspace,
  tools: Tools,
  prepared: Prepared,
  m: { modelDir: string; model: string },
  harnessMemory = true,
): AdapterContext => ({
  workspace,
  tools,
  release: prepared.release,
  releaseHome: prepared.home,
  modelDir: m.modelDir,
  model: m.model,
  harnessMemory,
});

const minutesSince = (t0: number): string => ((Date.now() - t0) / MINUTE).toFixed(1);

/** The number of units: `--units`, or floor(W / 4) from `width.json`, lowered by the guard. */
async function unitsFor(
  values: Values,
  reading: Parameters<typeof lowerUnits>[1],
): Promise<number> {
  const wanted =
    values.units !== undefined
      ? Number(values.units)
      : (
          JSON.parse(
            await readFile(values.width ?? "width.json", "utf8").catch(() => {
              throw new Error(
                "no --units and no width.json: run `live --calibrate` first, or pass --units",
              );
            }),
          ) as { units: number }
        ).units;
  const units = lowerUnits(wanted, reading);
  if (units < 1)
    throw new Error(`the seven-day window is too full for a unit (reading ${reading.utilization})`);
  if (units < wanted)
    console.log(`units lowered from ${wanted} to ${units} by the utilisation guard`);
  return units;
}

/** The run: set-up, freeze, the units in both arms, the result. */
export async function liveRun(values: Values): Promise<void> {
  const t0 = Date.now();
  if (values["reading-from"] === undefined)
    throw new Error(
      "pass --reading-from <folder>: the kept transcripts of a calibration, a harness-memory check or an earlier run made in the last 2 hours, which hold the window's utilisation events",
    );
  const reading = await readingFromRun(values["reading-from"]);
  const guard = new Guard(reading); // refuses here, before anything starts, with no reading
  const units = await unitsFor(values, reading as NonNullable<typeof reading>);
  const m = await machine(values);
  const items = await loadItems();
  const adapter = adapterFor("uketsugi");
  const config = configurationOf(adapter, values.config);
  await refuseBrokenPatterns(adapter, items);
  await withWorkspace(async (workspace) => {
    const { prepared, warmCache } = await setUp(workspace, m.tools, values);
    console.log(`set-up done in ${minutesSince(t0)} min`);
    if (Date.now() - t0 > SET_UP_STOP_MS)
      throw new Error(
        `set-up was not done by minute 10 (${minutesSince(t0)}): no task session was started`,
      );
    const out = outOf(values, `${config}-${units}`);
    await mkdir(join(out, "cases"), { recursive: true });
    const version = (await run(m.tools.claude as string, ["--version"])).stdout.trim();
    const hash = await freeze(out, {
      folders: manifestFolders(),
      config,
      model: m.model,
      harness: version,
    });
    const context = contextOf(workspace, m.tools, prepared, m);
    const host = new LiveHost({
      chain: prepared.chain,
      rebuilt: prepared.rebuilt,
      judge: prepared.judge,
      context,
      tools: m.tools,
      items,
      arms: armsOf(config),
      out,
      warmCache,
      startedAt: t0,
    });
    console.log(
      await runUnits(host, {
        units,
        guard,
        work: workspace.at("work"),
        out,
        build: prepared.build.head.slice(0, 7),
        config,
        model: m.model,
        hash,
        pool: values.pool?.split(",") ?? [],
        scoring: { items, spec: adapter.memory, boilerplate: adapter.boilerplate },
        harness: () => host.harness,
      }),
    );
    console.log(`result: ${out}`);
  });
}

/** Set-up with no task session, timed: rebuild and prove, release, warm cache, and every unit's case opened with its setup session, in parallel. */
export async function prepareOnly(values: Values): Promise<void> {
  const t0 = Date.now();
  const m = await machine(values);
  const adapter = adapterFor("uketsugi");
  const config = configurationOf(adapter, values.config);
  const units = Number(values.units ?? 4);
  await withWorkspace(async (workspace) => {
    const { prepared } = await setUp(workspace, m.tools, values);
    console.log(`rebuilt, proved, built and warmed in ${minutesSince(t0)} min`);
    const context = contextOf(workspace, m.tools, prepared, m);
    const opened = await Promise.all(
      Array.from({ length: units }, (_, i) =>
        Case.open({
          adapter,
          context,
          tools: m.tools,
          config,
          name: `unit-${i + 1}`,
          chain: prepared.chain,
          seeded: false,
        }),
      ),
    );
    await Promise.all(opened.map((c) => c.close()));
    const taken = Date.now() - t0;
    console.log(
      `set-up of ${units} units took ${minutesSince(t0)} min (target 8, stop at 10): ${taken <= SET_UP_TARGET_MS ? "within the target" : taken <= SET_UP_STOP_MS ? "over the target" : "a run would have stopped"}`,
    );
  });
}

export async function liveCalibrate(values: Values): Promise<void> {
  const m = await machine(values);
  await withWorkspace(async (workspace) => {
    const { prepared } = await setUp(workspace, m.tools, values);
    const out = outOf(values, "calibrate");
    await mkdir(out, { recursive: true });
    const result = await calibrate({
      prepared,
      context: contextOf(workspace, m.tools, prepared, m, false),
      tools: m.tools,
      workspace,
      out,
    });
    console.log(JSON.stringify(result, null, 1));
    console.log(`width.json: ${join(out, "width.json")}`);
  });
}

export async function liveMemcheck(values: Values): Promise<void> {
  const m = await machine(values);
  await withWorkspace(async (workspace) => {
    const out = outOf(values, "memcheck");
    await mkdir(out, { recursive: true });
    const context = {
      workspace,
      tools: m.tools,
      model: m.model,
      modelDir: m.modelDir,
    } as AdapterContext;
    const result = await memcheck({ context, tools: m.tools, out });
    console.log(JSON.stringify(result, null, 1));
    console.log(
      result.passed
        ? "PASS: the later session answered from the harness's memory"
        : "FAIL: the later session did not read the harness's memory; the design's baseline is not what it says",
    );
    if (!result.passed) process.exitCode = 1;
  });
}
