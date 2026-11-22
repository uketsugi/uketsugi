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
import { cp, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { End } from "../recall/ending.ts";
import { copyHome, copyTree } from "../recall/copy.ts";
import type { Guard } from "../recall/quota.ts";

export const MINUTE = 60_000;
/** The deadlines inside the owner's hour (`fit.ts` says what each is for): the caps of the earlier and of a later session, and the last minute a later session may start. */
export interface Deadlines {
  readonly capEMs: number;
  readonly capLMs: number;
  readonly lastStartMs: number;
}
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
  /** Called by the host as the session's first step is about to start: what the later sessions need that does not depend on it can be made from here. */
  readonly sessionStarted?: () => void;
}

/** One phase of a unit's arm, on the run's clock: what took the time between the command and the result. */
export interface Phase {
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface Outcome {
  readonly end: End;
  /** What the host timed inside the session: opening the case, each step, each judging, the server's stop, the copies. */
  readonly phases?: readonly Phase[];
  /** When the session itself ended (its last step and the judging of it), before anything is stopped or copied. */
  readonly sessionEndMs?: number;
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
  /** Gives the home a later session will run in what does not depend on the earlier session (its private copy of the warm Go cache); called while the earlier session runs. */
  warmHome?(home: string): Promise<void>;
  /** Waits for what the host left to do after letting go of its sessions (copying their evidence, removing what they replaced), and says how long each took, by `u<unit>-<arm>`. */
  settle?(): Promise<Readonly<Record<string, readonly Phase[]>>>;
}

export interface SessionRecord {
  readonly startedMs: number | null;
  /** The session's own end: its last step and the judging of it. */
  readonly endedMs: number | null;
  /** When the host had stopped its server and let go of it: what the later sessions wait for. */
  readonly readyMs?: number | null;
  readonly end: End;
}

/** What went from E into L: the harness's own memory files and the instruction files. */
export interface Carried {
  readonly memory: readonly string[];
  readonly instructions: readonly string[];
}

export interface ArmRecord {
  /** Every phase of this arm, in the order they began, on the run's clock. */
  readonly phases: readonly Phase[];
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
  await copyHome(from.home, to.home);
  if (existsSync(from.data)) await copyTree(from.data, to.data);
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
  readonly deadlines: Deadlines;
}

/** Times each call of what it is given on `now`'s clock and pushes the phase. */
export function timerOf(
  now: () => number,
  phases: Phase[],
): <T>(name: string, fn: () => Promise<T>) => Promise<T> {
  return async (name, fn) => {
    const startMs = now();
    try {
      return await fn();
    } finally {
      phases.push({ name, startMs, endMs: now() });
    }
  };
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
    phases: Phase[],
    role: string,
  ): Promise<SessionRecord> {
    const { host, guard, deadlines } = this.options;
    const startedMs = host.now();
    const barred: End | undefined = !guard.mayStart()
      ? { kind: "void", cause: "quota", detail: "the window is near full: no session starts" }
      : startedMs > deadlines.lastStartMs
        ? { kind: "void", cause: "clock", detail: "past minute 30 of the run: no session starts" }
        : undefined;
    if (barred !== undefined) return { startedMs: null, endedMs: null, end: barred };
    const outcome = await go({
      ...job,
      capMs: job.task === undefined ? deadlines.capEMs : deadlines.capLMs,
    });
    guard.observe(outcome.readings, Date.now() / 1000);
    const readyMs = host.now();
    phases.push(...(outcome.phases ?? []).map((p) => ({ ...p, name: `${role}: ${p.name}` })));
    return { startedMs, endedMs: outcome.sessionEndMs ?? readyMs, readyMs, end: outcome.end };
  }

  /** One unit in one arm: E, then both L at once. */
  async arm(unit: number, arm: Arm): Promise<ArmRecord> {
    const { host, work } = this.options;
    const phases: Phase[] = [];
    const timed = timerOf(() => host.now(), phases);
    const dirs = dirsOf(work, unit, arm, "E");
    await timed("E: tree", () => host.tree("T1", dirs.tree));
    // The later sessions' trees do not depend on the earlier session: they are made while it runs, from the moment it starts.
    const trees = new Map<Later, Promise<void>>();
    const prefetch = (): void => {
      for (const task of LATER)
        if (!trees.has(task))
          trees.set(
            task,
            (async () => {
              const there = dirsOf(work, unit, arm, task);
              await timed(`${task}: tree`, () => host.tree(task, there.tree));
              if (host.warmHome !== undefined) {
                const warm = host.warmHome.bind(host);
                await timed(`${task}: warm`, () => warm(there.home));
              }
            })(),
          );
    };
    const earlier = await this.attempt(
      { unit, arm, dirs, sessionStarted: prefetch },
      (job) => host.earlier(job),
      phases,
      "E",
    );
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
        if (!trees.has(task)) prefetch();
        await trees.get(task);
        carried = await timed(`${task}: carry`, () => carry(dirs, there));
        later[task] = await this.attempt(
          { unit, arm, task, dirs: there },
          (job) => host.later(job),
          phases,
          task,
        );
      }),
    );
    await Promise.allSettled(trees.values());
    return { phases, earlier, later, carried };
  }
}

const voidOf = (arm: ArmRecord): boolean =>
  [arm.earlier, ...Object.values(arm.later)].some((s) => s.end.kind === "void");

/** Runs every unit in both arms at once, each as soon as its own parts allow, and says which units are void. */
export async function runPairs(options: PairOptions): Promise<UnitRecord[]> {
  const run = new Run(options);
  const units = await Promise.all(
    Array.from({ length: options.units }, async (_, n) => {
      const unit = n + 1;
      const [memory, none] = await Promise.all(ARMS.map((arm) => run.arm(unit, arm)));
      const arms = { memory: memory as ArmRecord, none: none as ArmRecord };
      return { unit, arms, void: voidOf(arms.memory) || voidOf(arms.none) };
    }),
  );
  const late = (await options.host.settle?.()) ?? {};
  const merged = (unit: number, arm: Arm, record: ArmRecord): ArmRecord => ({
    ...record,
    phases: [...record.phases, ...(late[`u${unit}-${arm}`] ?? [])].sort(
      (a, b) => a.startMs - b.startMs,
    ),
  });
  return units.map((u) => ({
    ...u,
    arms: {
      memory: merged(u.unit, "memory", u.arms.memory),
      none: merged(u.unit, "none", u.arms.none),
    },
  }));
}
