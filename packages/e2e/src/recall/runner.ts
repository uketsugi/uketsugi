/**
 * One case end to end: its sessions in order (plant, gap, probes) each on its own reference tree,
 * the task judged after each step with follow-ups, the store copied before the first probe and put
 * back before each later one, then the case scored from the evidence it left (`evidence.ts`). A case
 * never throws: an error is its record, with the evidence it got as far as keeping.
 */
import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, AdapterContext } from "./adapter.ts";
import { Case, PROJECT } from "./case.ts";
import { excludeBuildOutputs, makeTree, resetTree, type ChainData, type Rebuilt } from "./chain.ts";
import { SessionEnded, type End } from "./ending.ts";
import { scoreCase, type Scoring } from "./evidence.ts";
import { judge, type JudgeContext } from "./judge.ts";
import { probeTasks, type Item, type Items } from "./items.ts";
import type { Tools } from "./preflight.ts";
import { caseChain, type SessionPlan } from "./plan.ts";
import type { CaseRecord, Cell } from "./report.ts";
import { treeStatus } from "./firstwrite.ts";
import type { SessionResult } from "./session.ts";
import { uncleanOf } from "./server.ts";
import { spendOf } from "./spend.ts";
import { modelStepUsd } from "./uketsugi.ts";

export interface Suite {
  readonly adapter: Adapter;
  readonly adapterContext: AdapterContext;
  readonly tools: Tools;
  readonly chain: ChainData;
  readonly rebuilt: Rebuilt;
  readonly items: Items;
  readonly judge: JudgeContext;
  readonly scoring: Scoring;
  readonly gap: number;
  readonly resultsDir: string;
}

export interface Job {
  readonly config: string;
  readonly item: string;
  readonly kind: "treatment" | "control";
  readonly repeat: number;
}

/** What a finished case reports: its record, and the cells it measured. */
export type CaseOutcome = CaseRecord & { cells: Cell[] };

/** The evidence kept of a case, beside its record. */
const KEPT = [
  "facts.json",
  "facts-plant.json",
  "requests.jsonl",
  "llm.jsonl",
  "steps.jsonl",
  "chain.json",
  "arm.json",
  "server.log",
  "transcripts",
  "judge",
];

export const caseName = (job: Job): string => `${job.config}-${job.item}-${job.kind}-${job.repeat}`;

const writeJson = (path: string, value: unknown): Promise<void> =>
  writeFile(path, JSON.stringify(value, null, 1));

/** One session's running state: where its tree is, what it has said so far, and which step it is on. */
export interface Running {
  readonly c: Case;
  readonly suite: Suite;
  readonly plan: SessionPlan;
  readonly config: string;
  readonly tree: string;
  readonly baseline: ReadonlySet<string> | undefined;
  ident: string | null;
  setup: unknown;
  /** When the session must end, as a time: a step is stopped there, and no step starts after it. */
  readonly deadline?: number;
  readonly startedAt?: number;
  /** Set when the session was stopped at its deadline: nothing more is asked of it. */
  capped?: End;
  /** Set when the harness failed on its own (the recall suite goes on and judges the tree, as it always has; a live run records it). */
  harness?: End;
}

/** Whether the deadline has passed; the session is then capped, with the time it ran. */
function expired(run: Running): boolean {
  if (run.deadline === undefined || Date.now() < run.deadline) return run.capped !== undefined;
  run.capped ??= {
    kind: "capped",
    seconds: Math.round((Date.now() - (run.startedAt ?? run.deadline)) / 1000),
  };
  return true;
}

async function step(
  run: Running,
  kind: string,
  prompt: string,
  task: string | null,
): Promise<SessionResult> {
  const { c, plan } = run;
  const index = c.stepOf(plan.id);
  const result = await c.session({
    name: plan.id,
    tree: run.tree,
    prompt,
    resume: run.ident,
    ...(run.baseline === undefined ? {} : { baseline: run.baseline }),
    ...(run.deadline === undefined ? {} : { capMs: Math.max(1, run.deadline - Date.now()) }),
    stopAtFirstWrite: plan.kill_after === "write",
  });
  if (result.end.kind === "capped") run.capped = result.end;
  else if (result.end.kind === "harness") run.harness ??= result.end;
  else if (result.end.kind !== "done") throw new SessionEnded(result.end);
  run.ident ??= result.sessionId;
  if (index === 0) run.setup = result.setup;
  await appendFile(
    join(c.dir, "steps.jsonl"),
    JSON.stringify({
      session: plan.id,
      step: index,
      kind,
      harness: "claude",
      task,
      transcript: `transcripts/${plan.id}.${index}.jsonl`,
      rc: result.code,
      killed: result.killed,
      first_write: result.firstWrite,
      prompt: prompt.slice(0, 200),
    }) + "\n",
  );
  return result;
}

/** A task's steps: the task, then follow-ups while its hidden tests fail, or until the session is ended at its first write. */
async function task(run: Running, name: string): Promise<void> {
  const { c, suite, plan } = run;
  let prompt = (suite.chain.tasks[name] as { prompt: string }).prompt;
  for (let attempt = 0; attempt <= suite.chain.maxFollowups; attempt++) {
    if (expired(run)) return;
    const result = await step(run, attempt === 0 ? "task" : "followup", prompt, name);
    if (result.killed && run.capped === undefined) return;
    const judged = await judge(suite.judge, name, run.tree);
    await mkdir(join(c.dir, "judge"), { recursive: true });
    await writeJson(join(c.dir, "judge", `${plan.id}.${name}.${attempt}.json`), judged);
    if (judged.passed || run.capped !== undefined) return;
    prompt = suite.chain.followup;
  }
}

/** The steps of a session in order. What the person says after a task is said whether or not the task passed. */
export async function steps(run: Running): Promise<void> {
  const { suite, plan } = run;
  const row = suite.adapter.session(run.config);
  if (row.firstMessage !== undefined) await step(run, "activate", row.firstMessage, null);
  for (const x of plan.steps) {
    if (expired(run)) return;
    if ("reset" in x)
      await resetTree(suite.rebuilt, suite.rebuilt.parent[x.reset] as string, run.tree);
    else if ("task" in x) await task(run, x.task);
    else await step(run, "say", x.say_after_task, null);
  }
}

/** A session in `tree` (already at its reference), with the case's mail relay; its home is dropped when it ends. */
export async function sessionIn(
  c: Case,
  suite: Suite,
  plan: SessionPlan,
  config: string,
  tree: string,
  deadline?: number,
): Promise<Running> {
  const baseline = plan.role === "probe" ? await treeStatus(tree) : undefined;
  const run: Running = {
    c,
    suite,
    plan,
    config,
    tree,
    baseline,
    ident: null,
    setup: undefined,
    startedAt: Date.now(),
    ...(deadline === undefined ? {} : { deadline }),
  };
  await steps(run);
  return run;
}

/** A session on its own tree at the reference before its first task. */
async function session(c: Case, suite: Suite, plan: SessionPlan, config: string): Promise<unknown> {
  const first = plan.steps.find((x): x is { task: string } => "task" in x) as { task: string };
  const tree = join(c.dir, "trees", plan.id, "repo");
  await makeTree(suite.chain, suite.rebuilt, suite.rebuilt.parent[first.task] as string, tree);
  await excludeBuildOutputs(tree, suite.chain.exclude);
  const run = await sessionIn(c, suite, plan, config, tree);
  await rm(join(c.dir, "trees", plan.id), { recursive: true, force: true });
  await c.dropHome(plan.id);
  return run.setup;
}

/** The store before the first probe is kept and read; each later probe has the same store put back. */
async function storeBeforeProbe(c: Case, plan: SessionPlan, first: boolean): Promise<void> {
  if (!first) return c.restoreStore("probe");
  await c.snapshotStore("probe");
  await writeJson(join(c.dir, "facts.json"), await c.readStore(PROJECT));
}

async function sessions(
  c: Case,
  suite: Suite,
  plans: readonly SessionPlan[],
  config: string,
): Promise<Record<string, unknown>> {
  const setups: Record<string, unknown> = {};
  const firstProbe = plans.find((p) => p.role === "probe")?.id;
  for (const plan of plans) {
    if (plan.role === "probe") await storeBeforeProbe(c, plan, plan.id === firstProbe);
    setups[plan.id] = await session(c, suite, plan, config);
    if (plan.role === "plant")
      await writeJson(join(c.dir, "facts-plant.json"), await c.readStore(PROJECT));
  }
  return setups;
}

/** Runs and scores one case. */
export async function runCase(suite: Suite, job: Job): Promise<CaseOutcome> {
  const name = caseName(job);
  const key = {
    product: suite.adapter.name,
    config: job.config,
    item: job.item,
    kind: job.kind,
    repeat: job.repeat,
  } as const;
  const record: CaseOutcome = {
    ...key,
    model: suite.adapterContext.model,
    cells: [],
    ...(job.kind === "treatment"
      ? { expected: probeTasks(suite.items[job.item] as Item).length }
      : {}),
  };
  const started = Date.now();
  let c: Case | undefined;
  try {
    const control = job.kind === "control";
    const chain = caseChain(
      suite.items,
      suite.chain,
      job.item,
      suite.scoring.mode,
      suite.gap,
      control,
    );
    c = await Case.open({
      adapter: suite.adapter,
      context: suite.adapterContext,
      tools: suite.tools,
      config: job.config,
      name,
      chain: suite.chain,
    });
    await writeJson(join(c.dir, "chain.json"), chain);
    const memory = suite.adapter.memory;
    await writeJson(join(c.dir, "arm.json"), {
      name: job.config,
      memory: { call: memory.call, tool_search: memory.toolSearch, touch: memory.touch },
    });
    record.sessions = chain.sessions.length;
    record.setup = await sessions(c, suite, chain.sessions, job.config);
    Object.assign(record, await scoreCase(c.dir, key, suite.scoring));
  } catch (error) {
    if (error instanceof SessionEnded) record.end = error.end;
    record.error = (
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    ).slice(0, 500);
  }
  record.minutes = Math.round((Date.now() - started) / 6000) / 10;
  if (c !== undefined) await keep(c, name, suite, record);
  return record;
}

/** Copies what a case kept (`KEPT`) from its folder to `dest`. */
export async function copyEvidence(dir: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const file of KEPT)
    await cp(join(dir, file), join(dest, file), { recursive: true }).catch(() => undefined);
}

/** Copies the evidence to the results, then stops the case and removes what is big. */
export async function keep(
  c: Case,
  name: string,
  suite: Suite,
  record: CaseOutcome,
): Promise<void> {
  const dest = join(suite.resultsDir, "cases", name);
  try {
    await copyEvidence(c.dir, dest);
    Object.assign(record, await spendOf(c.dir).catch(() => ({})));
    if (c.serving.modelStep !== undefined)
      record.model_step_usd = Math.round(modelStepUsd(c.serving.modelStep) * 1e4) / 1e4;
  } finally {
    await c.close().catch(() => undefined);
    const unclean = uncleanOf(await readFile(join(c.dir, "server.log"), "utf8").catch(() => ""));
    record.killed_stops = unclean.killed;
    record.recovered_starts = unclean.recovered;
    for (const big of ["trees", "session-homes", "snapshots", "data"]) {
      await rm(join(c.dir, big), { recursive: true, force: true });
    }
  }
}
