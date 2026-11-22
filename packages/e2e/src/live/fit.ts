/**
 * Whether a run can finish, worked out before it starts, from this machine's measured times.
 *
 * The owner's hour does not move: the result is printed by minute 55 (`HOUR_MS`). Inside it the
 * deadlines are these, and each is what it is for a reason:
 * - an earlier session is capped at 22 minutes (`CAP_E_MS`): the design's, held: the smoke unit's
 *   took 13 to 16 minutes, so the cap is a tail that is hit rarely and costs the unit its
 *   measurement when it is;
 * - a later session is capped at 18 minutes (`CAP_L_MS`): the kept later sessions took 3 to 8.5
 *   minutes (the design's records go to 17), so 18 is above every one of them, and it is what
 *   makes the last start late enough that a capped earlier session still leaves its later ones
 *   time;
 * - no later session starts after `lastStartMs`: the hour, less the cap, less the tail of a later
 *   session (its last judging and its finish) and the printing, all as measured. It is computed,
 *   so that a slower machine gets an earlier last start, and then fewer units, not a void run.
 *
 * A unit fits when, even if its earlier session runs to its cap, its later sessions start by the
 * last start. N units are measured at once, so the times are those of the width they were
 * measured at; an N above that width is not measured and does not fit.
 */
import { MINUTE } from "./pair.ts";
import type { Deadlines, Phase, UnitRecord } from "./pair.ts";

export const HOUR_MS = 55 * MINUTE;
export const CAP_E_MS = 22 * MINUTE;
export const CAP_L_MS = 18 * MINUTE;

/** What one set of times, measured at `units` units at once, says of this machine. */
export interface Measured {
  readonly units: number;
  /** From the command to the first earlier session's start, when the release was cached, and when it was built. */
  readonly setupCachedMs: number | null;
  readonly setupBuiltMs: number | null;
  /** The slowest, over arms: what follows an earlier session's end until the host lets go of it (its judging is part of the session); getting a later session's tree and home. A session's cap counts from its attempt's start, so opening its case is inside it. */
  readonly eFinishMs: number;
  readonly gapMs: number;
  /** The slowest judging of a session's last step; what follows a later session until the host lets go; printing the result. A later session's tail is these three and `settleMs`. */
  readonly judgeMs: number;
  readonly lFinishMs: number;
  /** Copying a later session's evidence, which the result waits for. */
  readonly settleMs: number;
  readonly printMs: number;
}

export interface MeasuredSet {
  /** Measured widths, each from a run folder. */
  readonly byUnits: readonly Measured[];
}

const slowest = (xs: readonly number[]): number => xs.reduce((a, b) => Math.max(a, b), 0);

/** The times a finished run (or dry run) shows, for its width. `setup` is the run's set-up phases. */
export function measuredFrom(run: {
  units: readonly UnitRecord[];
  setup?: readonly Phase[];
  releaseCached?: boolean;
  printMs?: number;
}): Measured {
  const arms = run.units.flatMap((u) => [u.arms.memory, u.arms.none]);
  const ran = arms.filter((a) => a.earlier.endedMs !== null);
  const firstStart = slowest([]) + Math.min(...ran.map((a) => a.earlier.startedMs ?? Infinity));
  const setupMs = Number.isFinite(firstStart) ? firstStart : 0;
  const laters = ran.flatMap((a) =>
    (["T4", "T8"] as const).flatMap((t) => {
      const l = a.later[t];
      return l?.startedMs == null ? [] : [{ a, l }];
    }),
  );
  const judges = (a: (typeof arms)[number]): number[] =>
    a.phases.filter((p) => /: judge /.test(p.name)).map((p) => p.endMs - p.startMs);
  return {
    units: run.units.length,
    setupCachedMs: run.releaseCached === true ? setupMs : null,
    setupBuiltMs: run.releaseCached === true ? null : setupMs,
    eFinishMs: slowest(ran.map((a) => (a.earlier.readyMs ?? 0) - (a.earlier.endedMs ?? 0))),
    gapMs: slowest(laters.map(({ a, l }) => (l.startedMs ?? 0) - (a.earlier.readyMs ?? 0))),
    judgeMs: slowest(arms.flatMap(judges)),
    lFinishMs: slowest(laters.map(({ l }) => (l.readyMs ?? 0) - (l.endedMs ?? 0))),
    settleMs: slowest(
      arms.flatMap((a) =>
        a.phases
          .filter((p) => /^T[48]: copy evidence$/.test(p.name))
          .map((p) => p.endMs - p.startMs),
      ),
    ),
    printMs: run.printMs ?? 0,
  };
}

const slowerOf = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.max(a, b);

/** Joins what several runs measured, at their different widths: the same width twice keeps the slower of each time and every set-up seen. */
export function joined(sets: readonly Measured[]): MeasuredSet {
  const byUnits = new Map<number, Measured>();
  for (const m of sets) {
    const had = byUnits.get(m.units);
    if (had === undefined) byUnits.set(m.units, m);
    else
      byUnits.set(m.units, {
        units: m.units,
        setupCachedMs: slowerOf(m.setupCachedMs, had.setupCachedMs),
        setupBuiltMs: slowerOf(m.setupBuiltMs, had.setupBuiltMs),
        eFinishMs: Math.max(had.eFinishMs, m.eFinishMs),
        gapMs: Math.max(had.gapMs, m.gapMs),
        judgeMs: Math.max(had.judgeMs, m.judgeMs),
        lFinishMs: Math.max(had.lFinishMs, m.lFinishMs),
        settleMs: Math.max(had.settleMs, m.settleMs),
        printMs: Math.max(had.printMs, m.printMs),
      });
  }
  return { byUnits: [...byUnits.values()].sort((a, b) => a.units - b.units) };
}

export interface Fit {
  readonly fits: boolean;
  readonly units: number;
  readonly deadlines: Deadlines;
  /** The latest the set-up may end: past it, even a capped earlier session's later sessions would start after the last start, and the run stops before any task session. */
  readonly setupLimitMs: number;
  /** The arithmetic, line by line, in minutes. */
  readonly lines: readonly string[];
}

const m = (ms: number): string => (ms / MINUTE).toFixed(1);

/** The arithmetic for `units` units at the widest measure that covers them; `cached` says whether the release is already built. */
export function fitAt(set: MeasuredSet, units: number, cached: boolean): Fit {
  const at = set.byUnits.find((x) => x.units >= units);
  const empty: Deadlines = { capEMs: CAP_E_MS, capLMs: CAP_L_MS, lastStartMs: 0 };
  if (at === undefined)
    return {
      fits: false,
      units,
      deadlines: empty,
      setupLimitMs: 0,
      lines: [
        `${units} units: not measured (measured at ${set.byUnits.map((x) => x.units).join(", ") || "no width"} units); run \`live --dry-run\` at ${units} units and \`live --measure\` it`,
      ],
    };
  const setup = cached ? at.setupCachedMs : at.setupBuiltMs;
  if (setup === null)
    return {
      fits: false,
      units,
      deadlines: empty,
      setupLimitMs: 0,
      lines: [
        `${units} units: the set-up with ${cached ? "a cached" : "a freshly built"} release was not measured at ${at.units} units`,
      ],
    };
  const tail = at.judgeMs + at.lFinishMs + at.settleMs + at.printMs;
  const lastStartMs = HOUR_MS - CAP_L_MS - tail;
  const eStart = setup;
  const eEnd = eStart + CAP_E_MS + at.judgeMs;
  const lStart = eEnd + at.eFinishMs + at.gapMs;
  const lEnd = lStart + CAP_L_MS + tail;
  const setupLimitMs = lastStartMs - (lStart - setup);
  const lines = [
    `${units} units, measured at ${at.units} units at once, release ${cached ? "cached" : "built in the run"}:`,
    `  set-up ${m(setup)} -> earlier sessions start`,
    `  worst case, an earlier session runs to its cap: ${m(eStart)} + cap ${m(CAP_E_MS)} + last judging ${m(at.judgeMs)} = ends ${m(eEnd)}`,
    `  its server stops and its home goes forward ${m(at.eFinishMs)}, a later session's tree and copy ${m(at.gapMs)}: later sessions start ${m(lStart)}`,
    `  last start (hour ${m(HOUR_MS)} - cap ${m(CAP_L_MS)} - tail ${m(tail)}) = ${m(lastStartMs)}: ${lStart <= lastStartMs ? "margin" : "OVER by"} ${m(Math.abs(lastStartMs - lStart))}`,
    `  the set-up must be done by ${m(setupLimitMs)} (it took ${m(setup)} when measured): later, the run stops before any task session`,
    `  a later session to its cap ends ${m(lEnd)}, printed by ${m(HOUR_MS)}: margin ${m(HOUR_MS - lEnd)}`,
  ];
  return {
    fits: lStart <= lastStartMs && lEnd <= HOUR_MS,
    units,
    deadlines: { capEMs: CAP_E_MS, capLMs: CAP_L_MS, lastStartMs },
    setupLimitMs,
    lines,
  };
}

/** The largest N up to `wanted` that fits, with the arithmetic of every N tried; fits is false when none does. */
export function fitUnits(
  set: MeasuredSet,
  wanted: number,
  cached: boolean,
): Fit & { tried: readonly Fit[] } {
  const tried: Fit[] = [];
  for (let n = wanted; n >= 1; n--) {
    const fit = fitAt(set, n, cached);
    tried.push(fit);
    if (fit.fits) return { ...fit, tried };
  }
  const last = tried.at(-1) ?? fitAt(set, wanted, cached);
  return { ...last, fits: false, units: 0, tried };
}
