/**
 * The commands of `live` that start work: the run, `--prepare-only` (set-up with no task session,
 * timed), `--calibrate` and `--memcheck`. What every one needs is checked first and named when
 * missing; the run refuses before anything starts if it has no reading of the seven-day window.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, AdapterContext } from "../recall/adapter.ts";
import { adapterFor, configurationOf, DEFAULT_MODEL } from "../recall/adapters.ts";
import { Case, PROJECT } from "../recall/case.ts";
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
import { releaseCached } from "../recall/release.ts";
import { prepareDryHome, STAND_IN, type Dry, type DryDurations } from "./dry.ts";
import { refuseUsedFolder, takeMachine } from "./lock.ts";
import { fitUnits, CAP_E_MS, CAP_L_MS, HOUR_MS, type Fit } from "./fit.ts";
import { measureRuns, readMeasured } from "./measure.ts";
import { MINUTE, type Arm, type Job, type Phase } from "./pair.ts";
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
  readonly "provider-k"?: string;
  /** The dry run: the sessions' times, in seconds (a file of `DryDurations`), and what to scale them by. */
  readonly measured?: string;
  readonly measure?: string;
  readonly durations?: string;
  readonly scale?: string;
  readonly facts?: string;
}

/** Where a release is kept per commit. */
const RELEASE_CACHE = (): string => join(tmpdir(), "ukt-live-release-cache");

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");
const outOf = (values: Values, name: string): string =>
  values.out ?? join(tmpdir(), "ukt-live-results", `${stamp()}-${name}`);

/** The model folder, or why there is none: asked for before anything else, so that a run does not start without it. */
export function modelFolder(values: Values): string {
  const modelDir = values["model-dir"] ?? process.env["UKT_MODEL_DIR"];
  if (modelDir === undefined)
    throw new Error(
      "the embedding model: pass --model-dir <folder> or set UKT_MODEL_DIR to a folder that holds node_modules/ and models/ (what `ukt setup` makes: use a copy kept for tests, never an install under ~/.local); nothing has been started",
    );
  const problem = modelDirProblem(modelDir);
  if (problem !== undefined) throw new Error(`the embedding model: ${problem}`);
  return modelDir;
}

/** What every command that starts sessions needs, with each missing piece named. With `standIn`, the harness is that program and no sign-in is needed. */
async function machine(
  values: Values,
  standIn?: string,
): Promise<{ tools: Tools; modelDir: string; model: string }> {
  return {
    tools:
      standIn === undefined
        ? await preflight({ sessions: true })
        : { ...(await preflight({ sessions: false })), claude: standIn },
    modelDir: modelFolder(values),
    model: values.model ?? DEFAULT_MODEL,
  };
}

/** Holds the machine for `fn`: one live run at a time, in a folder of its own. */
async function holding<T>(command: string, out: string | null, fn: () => Promise<T>): Promise<T> {
  const release = await takeMachine(command, out);
  try {
    return await fn();
  } finally {
    release();
  }
}

const ergoOf = (values: Values): string => {
  if (values.ergo === undefined)
    throw new Error("pass --ergo <a local mirror of ergo>: the run fetches nothing");
  return values.ergo;
};

/** Rebuilds and proves the trees the run uses, builds and installs the release (cached per commit), and warms the Go cache. */
async function setUp(
  workspace: Workspace,
  tools: Tools,
  values: Values,
  onPhase?: (name: string, from: number, to: number) => void,
) {
  const chain = await loadLiveChain();
  const releaseCache = RELEASE_CACHE();
  const prepared = await prepare(workspace, tools, chain, ergoOf(values), true, {
    tasks: USED_TASKS,
    releaseCache,
    ...(onPhase === undefined ? {} : { onPhase }),
  });
  if (!prepared.verified)
    throw new Error(
      "the rebuilt chain is not proved: a task is not red at its parent and green at its squash",
    );
  const warming = Date.now();
  const warmCache = await warmGoCache(prepared, tools, workspace);
  onPhase?.("set-up: warm the Go cache", warming, Date.now());
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

/** The schedule of a run: the largest N that fits the hour on this machine's measured times, with the arithmetic; refuses, printing it, when none does. */
async function scheduleOf(values: Values, wanted: number, cached: boolean): Promise<Fit> {
  const fit = fitUnits(await readMeasured(values.measured), wanted, cached);
  if (!fit.fits)
    throw new Error(
      `${wanted} units do not fit the hour on this machine, and no smaller number does; nothing was started:\n${fit.tried.flatMap((f) => f.lines).join("\n")}`,
    );
  console.log(fit.lines.join("\n"));
  if (fit.units < wanted)
    console.log(`units lowered from ${wanted} to ${fit.units} to fit the hour`);
  return fit;
}

/** A dry run measures: its deadlines are the design's, and nothing is worked out. */
const DRY_SCHEDULE = (units: number): Fit => ({
  fits: true,
  units,
  deadlines: { capEMs: CAP_E_MS, capLMs: CAP_L_MS, lastStartMs: HOUR_MS - CAP_L_MS - 2 * MINUTE },
  setupLimitMs: 10 * MINUTE,
  lines: ["a dry run measures; it works no schedule out"],
});

/** The newest reading of the window (a dry run spends nothing, so it needs none); refuses without one. */
async function windowReading(values: Values, dry?: Dry) {
  if (dry !== undefined) return { utilization: 0, ok: true };
  if (values["reading-from"] === undefined)
    throw new Error(
      "pass --reading-from <folder>: the kept transcripts of a calibration, a harness-memory check or an earlier run made in the last 2 hours, which hold the window's utilisation events",
    );
  return (await readingFromRun(values["reading-from"])) as NonNullable<
    Awaited<ReturnType<typeof readingFromRun>>
  >;
}

/** The run: set-up, freeze, the units in both arms, the result. */
export async function liveRun(values: Values, dry?: Dry): Promise<void> {
  const t0 = Date.now();
  modelFolder(values);
  if (values.out !== undefined) await refuseUsedFolder(values.out);
  const reading = await windowReading(values, dry);
  const guard = new Guard(reading); // refuses here, before anything starts, with no reading
  const wanted = await unitsFor(values, reading);
  const cached = await releaseCached(RELEASE_CACHE());
  const plan = dry === undefined ? await scheduleOf(values, wanted, cached) : DRY_SCHEDULE(wanted);
  const units = plan.units;
  const items = await loadItems();
  const adapter = adapterFor("uketsugi");
  const config = configurationOf(adapter, values.config);
  await refuseBrokenPatterns(adapter, items);
  const out = outOf(values, `${config}-${units}${dry === undefined ? "" : "-dry"}`);
  await holding(dry === undefined ? "live (run)" : "live --dry-run", out, () =>
    withWorkspace(async (workspace) => {
      const standIn = dry === undefined ? undefined : await writeStandIn(workspace);
      if (dry !== undefined) process.env["CLAUDE_CODE_OAUTH_TOKEN"] ??= "dry-run-stand-in";
      const m = await machine(values, standIn);
      const setupPhases: Phase[] = [];
      const { prepared, warmCache } = await setUp(workspace, m.tools, values, (name, from, to) =>
        setupPhases.push({ name, startMs: from - t0, endMs: to - t0 }),
      );
      console.log(`set-up done in ${minutesSince(t0)} min`);
      if (Date.now() - t0 > plan.setupLimitMs)
        throw new Error(
          `set-up was not done by minute ${(plan.setupLimitMs / MINUTE).toFixed(1)} (${minutesSince(t0)}): no task session was started`,
        );
      await mkdir(join(out, "cases"), { recursive: true });
      const version = (await run(m.tools.claude as string, ["--version"])).stdout.trim();
      const hash = await freeze(out, {
        folders: manifestFolders(),
        config,
        model: m.model,
        harness: version,
      });
      const host = new LiveHost({
        chain: prepared.chain,
        rebuilt: prepared.rebuilt,
        judge: prepared.judge,
        context: contextOf(workspace, m.tools, prepared, m),
        tools: m.tools,
        items,
        arms: armsOf(config),
        out,
        warmCache,
        startedAt: t0,
        setupLimitMs: plan.setupLimitMs,
        ...(dry === undefined ? {} : dryHooks(dry, adapter)),
      });
      console.log(
        await runUnits(host, {
          units,
          guard,
          work: workspace.at("work"),
          out,
          deadlines: plan.deadlines,
          setup: setupPhases,
          releaseCached: prepared.release.cached,
          schedule: plan.lines,
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
    }),
  );
}

/** What the dry run does around a session: tells the stand-in its times, and has the memory arm's earlier session store facts. */
function dryHooks(dry: Dry, adapter: Adapter) {
  return {
    beforeSession: (job: Job, home: string) => prepareDryHome(dry, job, home),
    afterSession: async (job: Job, c: Case): Promise<void> => {
      if (dry.facts !== undefined && job.task === undefined && job.arm === "memory")
        await adapter.seed(c.serving, PROJECT, dry.facts);
    },
  };
}

/** The stand-in harness, written into the workspace. */
async function writeStandIn(workspace: Workspace): Promise<string> {
  const path = workspace.at("dry-claude");
  await writeFile(path, STAND_IN, { mode: 0o755 });
  return path;
}

/** The times a (dry) run's folder shows, joined into the file `--measured` reads. */
export async function liveMeasure(values: Values): Promise<void> {
  const out = values.out;
  if (out === undefined || values.measure === undefined)
    throw new Error("usage: live --measure <run folder>[,<run folder>...] --out <measured.json>");
  console.log(JSON.stringify(await measureRuns(values.measure.split(","), out), null, 1));
}

/** The dry run: the whole run with a stand-in for the harness and the times it is given; no tokens. */
export async function liveDry(values: Values): Promise<void> {
  if (values.durations === undefined)
    throw new Error(
      "pass --durations <file>: the sessions' times in seconds (see src/live/dry.ts)",
    );
  const durations = JSON.parse(await readFile(values.durations, "utf8")) as DryDurations;
  const facts =
    values.facts === undefined
      ? undefined
      : (JSON.parse(await readFile(values.facts, "utf8")) as Record<string, unknown>[]);
  await liveRun(values, {
    durations,
    scale: Number(values.scale ?? 1),
    ...(facts === undefined ? {} : { facts }),
  });
}

/** Set-up with no task session, timed: rebuild and prove, release, warm cache, and every unit's case opened with its setup session, in parallel. */
export async function prepareOnly(values: Values): Promise<void> {
  const t0 = Date.now();
  const m = await machine(values);
  const adapter = adapterFor("uketsugi");
  const config = configurationOf(adapter, values.config);
  const units = Number(values.units ?? 4);
  await holding("live --prepare-only", null, () =>
    withWorkspace(async (workspace) => {
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
    }),
  );
}

export async function liveCalibrate(values: Values): Promise<void> {
  const m = await machine(values);
  const out = outOf(values, "calibrate");
  await holding("live --calibrate", out, () =>
    withWorkspace(async (workspace) => {
      const { prepared } = await setUp(workspace, m.tools, values);
      const result = await calibrate({
        prepared,
        context: contextOf(workspace, m.tools, prepared, m, false),
        tools: m.tools,
        workspace,
        out,
        ...(values["provider-k"] === undefined
          ? {}
          : { providerMax: Number(values["provider-k"]) }),
      });
      console.log(JSON.stringify(result, null, 1));
      console.log(`width.json: ${join(out, "width.json")}`);
    }),
  );
}

export async function liveMemcheck(values: Values): Promise<void> {
  const m = await machine(values);
  const out = outOf(values, "memcheck");
  await holding("live --memcheck", out, () =>
    withWorkspace(async (workspace) => {
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
    }),
  );
}
