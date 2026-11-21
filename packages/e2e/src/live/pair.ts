/**
 * The pair shape of the live test. One unit, in each of two arms (memory and none), is E (T1, a
 * reset, T2, in one session) and then L (T4 and T8, each in a case of its own, on copies of E's
 * store and home, with E's `CLAUDE.md`, `AGENTS.md` and `.claude/` in its tree). A unit's L starts
 * as soon as its own E has ended and its server has stopped: nothing waits for another unit.
 *
 * What bounds it: a session is capped 22 minutes after it starts, none starts after minute 30 of
 * the run, and none starts once the utilisation guard says the window is near full. A session that
 * could not start is void, with the cause, and a unit with a void session is void in both arms.
 *
 * The host does what needs a harness, a server and a tree; this runs the order and the clock.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { End } from "../recall/ending.ts";
import type { Guard } from "../recall/quota.ts";

export const MINUTE = 60_000;
export const CAP_MS = 22 * MINUTE;
export const LAST_START_MS = 30 * MINUTE;
export const ARMS = ["memory", "none"] as const;
export const LATER = ["T4", "T8"] as const;

export type Arm = (typeof ARMS)[number];
export type Later = (typeof LATER)[number];

/** Where a session's home, tree and store are. */
export interface Dirs {
  readonly home: string;
  readonly tree: string;
  readonly data: string;
}

export interface Job {
  readonly unit: number;
  readonly arm: Arm;
  /** The later task; none for E. */
  readonly task?: Later;
  readonly dirs: Dirs;
  /** The session is stopped this long after it starts. */
  readonly capMs: number;
}

export interface Outcome {
  readonly end: End;
  /** Text of the session's transcripts that holds its rate-limit events, for the guard. */
  readonly readings: string;
}

export interface Host {
  /** Milliseconds since the run's command. */
  now(): number;
  /** Makes the reference tree before `task` at `dest`. */
  tree(task: string, dest: string): Promise<void>;
  /** Runs E, with the arm's set-up, in the case at `job.dirs`; when it returns, its server has been stopped by waiting for its exit. */
  earlier(job: Job): Promise<Outcome>;
  /** Runs one later session to its end in a case that holds the carried home and store. */
  later(job: Job): Promise<Outcome>;
}

export interface SessionRecord {
  readonly startedMs: number | null;
  readonly endedMs: number | null;
  readonly end: End;
}

/** What went from E into L: the harness's own memory files and the instruction files. */
export interface Carried {
  readonly memory: readonly string[];
  readonly instructions: readonly string[];
}

export interface ArmRecord {
  readonly earlier: SessionRecord;
  readonly later: Partial<Record<Later, SessionRecord>>;
  readonly carried: Carried;
}

export interface UnitRecord {
  readonly unit: number;
  readonly arms: Record<Arm, ArmRecord>;
  /** A session of the unit was void: the unit is void in both arms. */
  readonly void: boolean;
}

const INSTRUCTIONS = ["CLAUDE.md", "AGENTS.md", ".claude"];

/** The harness's memory files in a home: Claude Code keeps them under `.claude/projects/<tree>/memory/`. */
export async function memoryFilesOf(home: string): Promise<string[]> {
  const base = join(home, ".claude", "projects");
  const names = await readdir(base, { recursive: true }).catch(() => []);
  return names.filter((n) => /(^|\/)memory\//.test(n)).sort();
}

/** Copies E's home and store (an arm with no product has none), and E's tree's instruction files, to where L runs; says what went. */
export async function carry(from: Dirs, to: Dirs): Promise<Carried> {
  await mkdir(to.home, { recursive: true });
  await cp(from.home, to.home, { recursive: true, preserveTimestamps: true });
  if (existsSync(from.data))
    await cp(from.data, to.data, { recursive: true, preserveTimestamps: true });
  const instructions: string[] = [];
  for (const name of INSTRUCTIONS) {
    const copied = await cp(join(from.tree, name), join(to.tree, name), {
      recursive: true,
      errorOnExist: false,
    }).then(
      () => true,
      () => false,
    );
    if (copied) instructions.push(name);
  }
  return { memory: await memoryFilesOf(from.home), instructions };
}

export interface PairOptions {
  readonly units: number;
  readonly host: Host;
  readonly guard: Guard;
  /** Folder for the sessions' homes, trees and stores. */
  readonly work: string;
}

const dirsOf = (work: string, unit: number, arm: Arm, role: string): Dirs => ({
  home: join(work, `u${unit}`, arm, role, "home"),
  tree: join(work, `u${unit}`, arm, role, "tree"),
  data: join(work, `u${unit}`, arm, role, "data"),
});

class Run {
  private readonly options: PairOptions;

  constructor(options: PairOptions) {
    this.options = options;
  }

  /** Starts a session if the clock and the guard allow; otherwise says why it is void. */
  private async attempt(
    job: Omit<Job, "capMs">,
    go: (job: Job) => Promise<Outcome>,
  ): Promise<SessionRecord> {
    const { host, guard } = this.options;
    const startedMs = host.now();
    const barred: End | undefined = !guard.mayStart()
      ? { kind: "void", cause: "quota", detail: "the window is near full: no session starts" }
      : startedMs > LAST_START_MS
        ? { kind: "void", cause: "clock", detail: "past minute 30 of the run: no session starts" }
        : undefined;
    if (barred !== undefined) return { startedMs: null, endedMs: null, end: barred };
    const outcome = await go({ ...job, capMs: CAP_MS });
    guard.observe(outcome.readings, Date.now() / 1000);
    return { startedMs, endedMs: host.now(), end: outcome.end };
  }

  /** One unit in one arm: E, then both L at once. */
  async arm(unit: number, arm: Arm): Promise<ArmRecord> {
    const { host, work } = this.options;
    const dirs = dirsOf(work, unit, arm, "E");
    await host.tree("T1", dirs.tree);
    const earlier = await this.attempt({ unit, arm, dirs }, (job) => host.earlier(job));
    const later: Partial<Record<Later, SessionRecord>> = {};
    let carried: Carried = { memory: [], instructions: [] };
    await Promise.all(
      LATER.map(async (task) => {
        if (earlier.end.kind === "void") {
          later[task] = {
            startedMs: null,
            endedMs: null,
            end: { kind: "void", cause: earlier.end.cause, detail: "its earlier session was void" },
          };
          return;
        }
        const there = dirsOf(work, unit, arm, task);
        await host.tree(task, there.tree);
        carried = await carry(dirs, there);
        later[task] = await this.attempt({ unit, arm, task, dirs: there }, (job) =>
          host.later(job),
        );
      }),
    );
    return { earlier, later, carried };
  }
}

const voidOf = (arm: ArmRecord): boolean =>
  [arm.earlier, ...Object.values(arm.later)].some((s) => s.end.kind === "void");

/** Runs every unit in both arms at once, each as soon as its own parts allow, and says which units are void. */
export async function runPairs(options: PairOptions): Promise<UnitRecord[]> {
  const run = new Run(options);
  return Promise.all(
    Array.from({ length: options.units }, async (_, n) => {
      const unit = n + 1;
      const [memory, none] = await Promise.all(ARMS.map((arm) => run.arm(unit, arm)));
      const arms = { memory: memory as ArmRecord, none: none as ArmRecord };
      return { unit, arms, void: voidOf(arms.memory) || voidOf(arms.none) };
    }),
  );
}
