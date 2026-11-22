/**
 * What a live run reports, in order: the headline line, the ladder per item (told outright, told
 * in passing and found by the agent apart), the arms side by side, the voids and caps with their
 * causes, the model line of every server, and the comparison with the pool.
 *
 * The cap rule: a capped session is scored as judged at the cap, with its tokens to the cap. When
 * more than 1 in 10 of the later sessions of either arm is capped, the later-session cost test is
 * not run and the figure is printed as censored; so for the unit figure, with the earlier sessions
 * counted. A unit with a void session is void in both arms. The run is void when a memory-arm
 * server lacked the model, or when more than a quarter of the units are void.
 */
import { wilcoxonExact } from "./exact.ts";
import { ARMS, LATER, MINUTE, type Arm } from "./pair.ts";
import { ITEMS, TOLD, type Told } from "./data.ts";
import { DECIDING, rungsOf, type RunMeta, type UnitScore } from "./score.ts";

const CAPPED_SHARE = 0.1;
const VOID_SHARE = 0.25;
const mega = (tokens: number): string => `${(tokens / 1e6).toFixed(1)} M`;
const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);
const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : sum(xs) / xs.length);
const share = (a: number, b: number): string => `${a}/${b}`;

export interface Figures {
  /** Units that count: not void. */
  readonly counted: readonly UnitScore[];
  readonly voidUnits: number;
  readonly capped: number;
  readonly runVoid: string | null;
}

/** Whether a unit's memory-arm server said, when it settled, that its answers are not degraded: the embedding model loaded. */
const modelLoaded = (u: UnitScore): boolean =>
  u.arms.memory.modelLine?.includes("degraded=[]") === true;

const labelsOf = (units: readonly UnitScore[]): boolean =>
  units.some((u) => u.arms.memory.labelled !== null);

/** How many of the stored cells the patterns alone would have counted, over the counted units. */
const storedByPatterns = (counted: readonly UnitScore[]): number =>
  sum(counted.map((u) => ITEMS.filter((i) => u.arms.memory.storedByPatterns[i] === true).length));

/** What "stored" rests on: the hand labels (how many facts, how many cells differ from the patterns), or the patterns alone. */
export function basis(units: readonly UnitScore[]): string {
  if (!labelsOf(units))
    return "Stored rests on: patterns alone, a floor (a pattern misses some paraphrase).";
  const differing = sum(
    units.map(
      (u) =>
        ITEMS.filter(
          (i) =>
            (u.arms.memory.stored[i] === true) !== (u.arms.memory.storedByPatterns[i] === true),
        ).length,
    ),
  );
  const facts = sum(units.map((u) => u.arms.memory.labelled ?? 0));
  return `Stored rests on: hand labels of ${facts} stored facts (labels.json beside the run); ${differing} cells differ from what the patterns alone give.`;
}

export function figuresOf(units: readonly UnitScore[]): Figures {
  const counted = units.filter((u) => !u.void);
  const voidUnits = units.length - counted.length;
  const unloaded = units.filter(
    (u) => (!u.void || u.arms.memory.modelLine !== null) && !modelLoaded(u),
  );
  const leaked = units.filter((u) => u.leaked);
  const runVoid =
    leaked.length > 0
      ? `a no-memory session called the memory server, so the baseline had memory (units ${leaked.map((u) => u.unit).join(", ")})`
      : unloaded.length > 0
        ? `a memory-arm server did not show its model loaded (units ${unloaded.map((u) => u.unit).join(", ")})`
        : voidUnits > units.length * VOID_SHARE
          ? `${voidUnits} of ${units.length} units are void`
          : null;
  return { counted, voidUnits, capped: sum(units.map((u) => u.cappedSessions)), runVoid };
}

const laterOf = (units: readonly UnitScore[], arm: Arm) =>
  units.flatMap((u) => LATER.map((t) => u.arms[arm].later[t]));

/** Whether more than 1 in 10 of the sessions is capped. */
const censored = (capped: readonly boolean[]): boolean =>
  capped.length > 0 && capped.filter(Boolean).length > capped.length * CAPPED_SHARE;

interface Cost {
  readonly memory: number;
  readonly none: number;
  readonly p: number | null;
  readonly censored: boolean;
  /** Pairs of the later sessions left out because a session of the pair has no tokens. */
  readonly dropped: number;
}

/** Later sessions as pairs, memory against none by task within a unit: the mean a session, and the exact test unless censored. */
export function laterCost(units: readonly UnitScore[]): Cost {
  const all = units.flatMap((u) =>
    LATER.map((t) => ({ m: u.arms.memory.later[t], n: u.arms.none.later[t] })),
  );
  const pairs = all.flatMap(({ m, n }) =>
    m !== null && n !== null && m.tokens > 0 && n.tokens > 0 ? [{ m, n }] : [],
  );
  const cut = ARMS.some((arm) =>
    censored(laterOf(units, arm).flatMap((l) => (l === null ? [] : [l.capped]))),
  );
  return {
    memory: mean(pairs.map((x) => x.m.tokens)),
    none: mean(pairs.map((x) => x.n.tokens)),
    p: cut ? null : wilcoxonExact(pairs.map((x) => Math.log(x.m.tokens / x.n.tokens))),
    censored: cut,
    dropped: all.length - pairs.length,
  };
}

/** The whole unit: E and both later sessions, per unit; censored by the same rule with the earlier sessions counted. */
export function unitCost(units: readonly UnitScore[]): Cost {
  const total = (u: UnitScore, arm: Arm): number =>
    u.arms[arm].earlier.tokens + sum(LATER.map((t) => u.arms[arm].later[t]?.tokens ?? 0));
  const flags = ARMS.map((arm) =>
    units.flatMap((u) => [
      u.arms[arm].earlier.capped,
      ...LATER.map((t) => u.arms[arm].later[t]?.capped ?? false),
    ]),
  );
  return {
    memory: mean(units.map((u) => total(u, "memory"))),
    none: mean(units.map((u) => total(u, "none"))),
    p: null,
    censored: flags.some(censored),
    dropped: 0,
  };
}

const change = (c: Cost): string =>
  c.none === 0
    ? "n/a"
    : `${c.memory < c.none ? "−" : "+"}${Math.abs(Math.round((c.memory / c.none - 1) * 100))}%`;

function costText(c: Cost, withP: boolean): string {
  const left = c.dropped > 0 ? ` [${c.dropped} pairs left out: a session with no tokens]` : "";
  return costFigure(c, withP) + left;
}

function costFigure(c: Cost, withP: boolean): string {
  if (c.censored)
    return `${mega(c.memory)} vs ${mega(c.none)} (censored: over 1 in 10 capped, no test)`;
  return `${mega(c.memory)} vs ${mega(c.none)} a ${withP ? "session" : "unit"} (${change(c)}${withP && c.p !== null ? `, p ${c.p.toFixed(2)}` : ""})`;
}

/** Units whose earlier session ran, void or not: what they stored is known whatever became of their later sessions. */
const ranEarlier = (units: readonly UnitScore[]): UnitScore[] =>
  units.filter((u) => u.arms.memory.timing.earlierEndMs !== null);

function storedByTold(counted: readonly UnitScore[], kind: Told): string {
  const items = ITEMS.filter((i) => TOLD[i] === kind);
  const hits = sum(
    counted.map((u) => items.filter((i) => u.arms.memory.stored[i] === true).length),
  );
  return share(hits, counted.length * items.length);
}

/** Beside the stored figure of a labelled run: the figure the patterns alone give, when it differs. */
function labelNote(counted: readonly UnitScore[], byLabels: number): string {
  if (!labelsOf(counted)) return "";
  const patterns = storedByPatterns(counted);
  return patterns === byLabels
    ? " by labels"
    : ` by labels (by patterns alone ${patterns}/${counted.length * ITEMS.length})`;
}

/** The one line, first. */
export function headline(meta: RunMeta, units: readonly UnitScore[]): string {
  const f = figuresOf(units);
  const cells = f.counted.flatMap((u) => Object.values(rungsOf(u)));
  const stored = cells.filter((c) => c.stored);
  const found = stored.filter((c) => c.found !== null);
  const ran = ranEarlier(units);
  const storedCells = ran.flatMap((u) => Object.values(rungsOf(u))).filter((c) => c.stored);
  const voidNote =
    ran.length === f.counted.length
      ? ""
      : ` [from the ${ran.length} units whose earlier session ran, ${ran.length - f.counted.length} of them void]`;
  const decide = (arm: Arm): number =>
    sum(
      f.counted.map(
        (u) =>
          DECIDING.filter((i) => LATER.some((t) => u.arms[arm].later[t]?.tests[i] === true)).length,
      ),
    );
  const passes = (arm: Arm): number =>
    laterOf(f.counted, arm).filter((l) => l?.passed === true).length;
  const total = sum(
    units.flatMap((u) =>
      ARMS.map((a) => u.arms[a].earlier.usd + sum(LATER.map((t) => u.arms[a].later[t]?.usd ?? 0))),
    ),
  );
  const lead = f.runVoid === null ? "" : `VOID (${f.runVoid}) · `;
  return [
    `${lead}live-hour ${meta.build} ${meta.config} ${meta.model}`,
    `${units.length} units, ${f.voidUnits} void, ${f.capped} capped, ${Math.round(meta.minutes)} min`,
    `stored ${share(storedCells.length, ran.length * ITEMS.length)}${labelNote(ran, storedCells.length)} (outright ${storedByTold(ran, "outright")}, in passing ${storedByTold(ran, "passing")}, found ${storedByTold(ran, "found")})${voidNote}`,
    `found ${share(found.length, stored.length)}`,
    `used ${share(found.filter((c) => c.used).length, found.length)}`,
    `deciding tests with memory ${share(decide("memory"), f.counted.length * DECIDING.length)}, without ${share(decide("none"), f.counted.length * DECIDING.length)}`,
    `tasks ${share(passes("memory"), f.counted.length * LATER.length)} vs ${share(passes("none"), f.counted.length * LATER.length)}`,
    `later sessions ${costText(laterCost(f.counted), true)}`,
    `whole unit ${costText(unitCost(f.counted), false)}`,
    `$${total.toFixed(2)}`,
  ].join(" · ");
}

/** The ladder per item: each rung's count among the units that reached it, and the routes of found apart. */
export function ladder(units: readonly UnitScore[]): string {
  const counted = units.filter((u) => !u.void);
  const ran = ranEarlier(units);
  const rows = ITEMS.map((item) => {
    const storedHere = ran.map((u) => rungsOf(u)[item]).filter((c) => c !== undefined);
    const cells = counted.map((u) => rungsOf(u)[item]).filter((c) => c !== undefined);
    const stored = cells.filter((c) => c.stored);
    const found = stored.filter((c) => c.found !== null);
    const brief = found.filter((c) => c.found === "brief").length;
    return `${item.padEnd(3)} ${(TOLD[item] + ",").padEnd(9)} stored ${share(storedHere.filter((c) => c.stored).length, storedHere.length)}  found ${share(found.length, stored.length)} (brief ${brief}, search ${found.length - brief})  used ${share(found.filter((c) => c.used).length, found.length)}`;
  });
  return [
    `The ladder, per item (a cell is a unit; stored counts every unit whose earlier session ran, void or not; found and used count the units that were not void):`,
    ...rows,
  ].join("\n");
}

/** The arms side by side. */
export function arms(units: readonly UnitScore[]): string {
  const counted = units.filter((u) => !u.void);
  const line = (arm: Arm): string => {
    const all = counted.flatMap((u) => [
      u.arms[arm].earlier,
      ...LATER.map((t) => u.arms[arm].later[t]),
    ]);
    const later = laterOf(counted, arm);
    const tests = sum(
      counted.map(
        (u) =>
          DECIDING.filter((i) => LATER.some((t) => u.arms[arm].later[t]?.tests[i] === true)).length,
      ),
    );
    return `${arm.padEnd(7)} passes ${share(later.filter((l) => l?.passed === true).length, later.length)}  item tests ${share(tests, counted.length * DECIDING.length)}  tokens ${mega(sum(all.map((s) => s?.tokens ?? 0)))}  $${sum(all.map((s) => s?.usd ?? 0)).toFixed(2)}  minutes ${sum(counted.map((u) => u.arms[arm].minutes)).toFixed(0)}`;
  };
  return ["The arms:", ...ARMS.map(line)].join("\n");
}

/** What the earlier session stored that matched no item, so that a reader sees what "not stored" rests on. */
export function unmatched(units: readonly UnitScore[]): string {
  const rows = units.flatMap((u) =>
    u.arms.memory.unmatched.map(
      (claim) => `u${u.unit}: ${claim.replace(/\s+/g, " ").slice(0, 220)}`,
    ),
  );
  return [
    "Facts the earlier session stored that matched no item (a pattern misses some paraphrase: read these before trusting a 'not stored'):",
    ...(rows.length === 0 ? ["none"] : rows),
  ].join("\n");
}

const min = (ms: number): string => (ms / MINUTE).toFixed(1);

/** One arm's path from the earlier session's end to the later sessions' start, phase by phase. */
function armTiming(u: UnitScore, arm: Arm): string {
  const t = u.arms[arm].timing;
  const ended = t.earlierEndMs;
  if (ended === null) return `u${u.unit} ${arm}: the earlier session did not start`;
  const length = (name: string): number =>
    t.phases.filter((p) => p.name === name).reduce((sum, p) => sum + p.endMs - p.startMs, 0);
  const ready =
    t.earlierReadyMs === null
      ? ""
      : `, ready ${min(t.earlierReadyMs)} (stop ${min(length("E: stop server"))}, evidence ${min(length("E: copy evidence"))})`;
  const later = LATER.map((task) => {
    const started = t.laterStartMs[task];
    return started === null
      ? `${task} did not start`
      : `${task}: tree ${min(length(`${task}: tree`))}, carry ${min(length(`${task}: carry`))}, started ${min(started)} (${min(started - ended)} after the earlier session ended)`;
  }).join("; ");
  const slowest = [...t.phases].sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))[0];
  const slow =
    slowest === undefined
      ? ""
      : `; slowest phase ${slowest.name} ${min(slowest.endMs - slowest.startMs)} min`;
  return `u${u.unit} ${arm}: earlier session ${min(t.earlierStartMs ?? 0)}-${min(ended)}${ready}; ${later}${slow}`;
}

/** Where the time went, unit by unit and arm by arm, and the slowest phase of each. */
export function timing(units: readonly UnitScore[]): string {
  const rows = units.flatMap((u) => ARMS.map((arm) => armTiming(u, arm)));
  return ["Timing, in minutes on the run's clock (every phase is in run.json):", ...rows].join(
    "\n",
  );
}

export function voids(units: readonly UnitScore[]): string {
  const lines = units.flatMap((u) => u.voids);
  const capped = units
    .filter((u) => u.cappedSessions > 0)
    .map((u) => `u${u.unit}: ${u.cappedSessions} capped`);
  return [
    "Voids and caps:",
    ...(lines.length + capped.length === 0 ? ["none"] : [...lines, ...capped]),
  ].join("\n");
}

export function modelLines(units: readonly UnitScore[]): string {
  return [
    "Model line of every server:",
    ...units.map((u) => `u${u.unit} memory: ${u.arms.memory.modelLine ?? "no server log kept"}`),
  ].join("\n");
}

export function render(meta: RunMeta, units: readonly UnitScore[], pooled: string): string {
  return [
    headline(meta, units),
    "",
    basis(units),
    "",
    ladder(units),
    "",
    unmatched(units),
    "",
    arms(units),
    "",
    timing(units),
    "",
    voids(units),
    "",
    modelLines(units),
    "",
    pooled,
  ].join("\n");
}
