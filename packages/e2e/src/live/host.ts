/**
 * The host of the pair shape (`pair.ts`) for a real run: it opens a case for each session, runs the
 * earlier session (T1, a reset, T2, in one session) or a later one on the case's tree, judges and
 * follows up as the recall suite's task loop does, keeps each session's evidence where `score.ts`
 * reads it (`<run>/cases/u<unit>-<arm>-<E|T4|T8>/`), and stops the case's server by waiting for it
 * before anything is copied from the case. The earlier session's home is the one carried, so what
 * the harness wrote into its own memory goes with it.
 */
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMemoryCall, type Adapter, type AdapterContext } from "../recall/adapter.ts";
import { parseTranscript } from "../recall/transcript.ts";
import { Case, PROJECT } from "../recall/case.ts";
import { excludeBuildOutputs, makeTree, type ChainData, type Rebuilt } from "../recall/chain.ts";
import { SessionEnded, type End } from "../recall/ending.ts";
import type { JudgeContext } from "../recall/judge.ts";
import type { Items } from "../recall/items.ts";
import type { SessionPlan } from "../recall/plan.ts";
import type { Tools } from "../recall/preflight.ts";
import { run } from "../recall/process.ts";
import { copyEvidence, sessionIn, type Suite } from "../recall/runner.ts";
import { MINUTE, type Arm, type Host, type Job, type Outcome } from "./pair.ts";
import { writeFile } from "node:fs/promises";

/** An arm's product and its configuration. */
export interface ArmProduct {
  readonly adapter: Adapter;
  readonly config: string;
}

export interface LiveSetup {
  readonly chain: ChainData;
  readonly rebuilt: Rebuilt;
  readonly judge: JudgeContext;
  readonly context: AdapterContext;
  readonly tools: Tools;
  readonly items: Items;
  readonly arms: Readonly<Record<Arm, ArmProduct>>;
  /** The run's folder: the evidence is kept in its `cases/`. */
  readonly out: string;
  /** A Go build cache warmed once, copied into each case's home; none when it was not made. */
  readonly warmCache?: string;
  /** The time the run's command was given, in epoch milliseconds. */
  readonly startedAt: number;
}

/** A case's set-up may not take longer than this from the command: later, its units are void. */
export const SET_UP_LIMIT_MS = 10 * MINUTE;

const readingsOf = async (dir: string): Promise<string> => {
  const folder = join(dir, "transcripts");
  const names = await readdir(folder).catch(() => []);
  const lines: string[] = [];
  for (const name of names)
    for (const line of (await readFile(join(folder, name), "utf8")).split("\n"))
      if (line.includes('"rate_limit_event"')) lines.push(line);
  return lines.join("\n");
};

const failed = (error: unknown): End =>
  error instanceof SessionEnded
    ? error.end
    : {
        kind: "harness",
        code: null,
        detail: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      };

export class LiveHost implements Host {
  /** The harness's version, as its first session reported it. */
  harness = "";
  private readonly setup: LiveSetup;

  constructor(setup: LiveSetup) {
    this.setup = setup;
  }

  now = (): number => Date.now() - this.setup.startedAt;

  async tree(task: string, dest: string): Promise<void> {
    const { chain, rebuilt } = this.setup;
    await makeTree(chain, rebuilt, rebuilt.parent[task] as string, dest);
    await excludeBuildOutputs(dest, chain.exclude);
  }

  /** E: the product's set-up session (in `Case.open`), then T1, a reset to T2's parent, and T2, with the words said after each. */
  earlier(job: Job): Promise<Outcome> {
    const { chain } = this.setup;
    const say = (task: string): { say_after_task: string }[] => {
      const words = chain.tasks[task]?.sayAfterTask;
      return words === undefined ? [] : [{ say_after_task: words }];
    };
    const plan: SessionPlan = {
      id: "E",
      harness: "claude",
      role: "plant",
      steps: [{ task: "T1" }, ...say("T1"), { reset: "T2" }, { task: "T2" }, ...say("T2")],
    };
    return this.session(job, plan, false);
  }

  later(job: Job): Promise<Outcome> {
    const plan: SessionPlan = {
      id: "L",
      harness: "claude",
      role: "probe",
      steps: [{ task: job.task as string }],
    };
    return this.session(job, plan, true);
  }

  private suiteFor(arm: Arm): Suite {
    const s = this.setup;
    return {
      adapter: s.arms[arm].adapter,
      adapterContext: s.context,
      tools: s.tools,
      chain: s.chain,
      rebuilt: s.rebuilt,
      items: s.items,
      judge: s.judge,
      scoring: { items: s.items, seedClaims: new Set(), boilerplate: [], mode: "full" },
      gap: 0,
      resultsDir: s.out,
    };
  }

  private async session(job: Job, plan: SessionPlan, carried: boolean): Promise<Outcome> {
    const s = this.setup;
    const { adapter, config } = s.arms[job.arm];
    const name = `u${job.unit}-${job.arm}-${job.task ?? "E"}`;
    const dir = dirname(job.dirs.home);
    const deadline = Date.now() + job.capMs;
    let c: Case | undefined;
    let end: End = { kind: "done" };
    try {
      c = await Case.open({
        adapter,
        context: s.context,
        tools: s.tools,
        config,
        name,
        chain: s.chain,
        dir,
        seeded: false,
        carried,
      });
      if (this.now() > SET_UP_LIMIT_MS && !carried) {
        end = { kind: "void", cause: "clock", detail: "set-up was not done by minute 10" };
      } else {
        if (s.warmCache !== undefined) await this.warm(c.home);
        const ran = await sessionIn(
          c,
          this.suiteFor(job.arm),
          plan,
          config,
          job.dirs.tree,
          deadline,
        );
        this.harness ||= (ran.setup as { version?: string } | undefined)?.version ?? "";
        end = ran.capped ?? ran.harness ?? end;
      }
    } catch (error) {
      end = failed(error);
    }
    if (c !== undefined) await this.finish(c, name, plan.id);
    if (job.arm === "none" && end.kind !== "void") end = (await this.leak(dir, name)) ?? end;
    return { end, readings: await readingsOf(dir) };
  }

  /** A no-memory session whose transcripts show a call to the memory server: the baseline had memory, and the run is void. Said loudly. */
  private async leak(dir: string, name: string): Promise<End | undefined> {
    const spec = this.setup.arms.memory.adapter.memory;
    // only what can be a call to the memory server: its tool names (and a tool search for it), not any string that holds the product's name
    const memory = { ...spec, touch: [] };
    const folder = join(dir, "transcripts");
    for (const file of await readdir(folder).catch(() => [])) {
      const called = parseTranscript(await readFile(join(folder, file), "utf8")).calls.find((c) =>
        isMemoryCall(memory, c.name, c.input),
      );
      if (called === undefined) continue;
      const detail = `the no-memory session ${name} called ${called.name}: the baseline had memory`;
      console.error(`RUN VOID: ${detail}`);
      return { kind: "void", cause: "baseline", detail };
    }
    return undefined;
  }

  /** Copies the warm Go build cache into a home, where Go looks for it. */
  private async warm(home: string): Promise<void> {
    const cache = join(home, ".cache", "go-build");
    await mkdir(dirname(cache), { recursive: true });
    await run("cp", ["-a", join(this.setup.warmCache as string, "go-build"), cache]);
  }

  /**
   * Keeps the case's evidence and the store as it stands, then stops the server by waiting for its
   * exit. The home that goes on is the session's own, which holds what the harness wrote.
   */
  private async finish(c: Case, name: string, session: string): Promise<void> {
    await writeFile(
      join(c.dir, "facts.json"),
      JSON.stringify(await c.readStore(PROJECT).catch(() => [])),
    );
    await c.close().catch(() => undefined);
    const own = join(c.dir, "session-homes", session);
    await readdir(own).then(
      async () => {
        await rm(c.home, { recursive: true, force: true });
        await run("cp", ["-a", own, c.home]);
      },
      () => undefined,
    );
    await copyEvidence(c.dir, join(this.setup.out, "cases", name));
  }
}
