/**
 * A live run scored from the evidence it kept, with no session. The run's folder holds `run.json`
 * (what `pair.ts` recorded of each unit, and the run's settings) and one case folder per session,
 * `cases/u<unit>-<arm>-<E|T4|T8>/`, in the layout the recall suite keeps (`steps.jsonl`,
 * `transcripts/`, `judge/<session>.<task>.<n>.json`, `requests.jsonl`, `server.log`), and for E
 * `facts.json`, the store when E ended.
 *
 * The ladder of an item in a unit's memory arm ends on the first rung it fails: not stored,
 * stored and not found, found and not used, used. How it was said to E (`TOLD`) is kept apart.
 */
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MemorySpec, StoreFact } from "../recall/adapter.ts";
import { deliveriesOf, stepRows, writeOf } from "../recall/evidence.ts";
import { patternOf, type Item, type Items } from "../recall/items.ts";
import { Seed, boilerplateStarts, recalled, stored } from "../recall/measure.ts";
import { spendOf } from "../recall/spend.ts";
import { ITEMS, TOLD } from "./data.ts";
import { ARMS, LATER, type Arm, type Later, type UnitRecord } from "./pair.ts";

export const DECIDING = ["D1", "D2", "P1"] as const;

export interface RunMeta {
  readonly build: string;
  readonly config: string;
  readonly model: string;
  readonly harness: string;
  readonly hash: string;
  readonly minutes: number;
}

export interface RunFile extends RunMeta {
  readonly units: readonly UnitRecord[];
}

export interface Rungs {
  readonly stored: boolean;
  /** Found in time, and by which route; null when not found. */
  readonly found: "brief" | "search" | null;
  /** The item's hidden tests passed at the end of L. */
  readonly used: boolean;
}

export interface SessionScore {
  readonly tokens: number;
  readonly usd: number;
  readonly capped: boolean;
}

export interface LaterScore extends SessionScore {
  readonly passed: boolean;
  /** Each item's tests in this task: passed at the end or not. */
  readonly tests: Record<string, boolean>;
  readonly found: Record<string, "brief" | "search" | null>;
}

export interface ArmScore {
  readonly earlier: SessionScore;
  readonly later: Record<Later, LaterScore | null>;
  /** The memory arm's store when E ended, item by item; empty for the other arm. */
  readonly stored: Record<string, boolean>;
  /** What the server's log says of its model; null for an arm with no server. */
  readonly modelLine: string | null;
  /** Minutes the arm's sessions ran, from their starts to their ends. */
  readonly minutes: number;
}

export interface UnitScore {
  readonly unit: number;
  readonly void: boolean;
  readonly voids: readonly string[];
  /** A no-memory session called the memory server. */
  readonly leaked: boolean;
  readonly cappedSessions: number;
  readonly sessions: number;
  readonly arms: Record<Arm, ArmScore>;
}

export interface Scoring {
  readonly items: Items;
  readonly spec: MemorySpec;
  readonly boilerplate: readonly string[];
}

function itemOf(items: Items, name: string): Item {
  const item = items[name];
  if (item === undefined) throw new Error(`no item ${name}`);
  return item;
}

const load = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;

/** The tests of an item in the later task `task`, or none. */
const testsOf = (items: Items, item: string, task: Later): readonly string[] =>
  items[item]?.tests[task] ?? [];

/** The last judgement of a later task, or undefined when none was kept. */
async function lastJudgement(
  dir: string,
  task: Later,
): Promise<{ passed: boolean; tests: Record<string, string> } | undefined> {
  const folder = join(dir, "judge");
  if (!existsSync(folder)) return undefined;
  const mine = (await readdir(folder))
    .filter((n) => n.startsWith(`L.${task}.`))
    .sort((a, b) => Number(a.split(".")[2]) - Number(b.split(".")[2]));
  const last = mine.at(-1);
  return last === undefined ? undefined : load(join(folder, last));
}

async function spendOrZero(dir: string): Promise<{ tokens: number; usd: number }> {
  return existsSync(join(dir, "requests.jsonl")) ? spendOf(dir) : { tokens: 0, usd: 0 };
}

/** The later session of `task`: its tests, and whether each item it needs was found before its first write, and by which route. */
async function laterScore(
  dir: string,
  task: Later,
  facts: readonly StoreFact[],
  capped: boolean,
  scoring: Scoring,
): Promise<LaterScore> {
  const judged = await lastJudgement(dir, task);
  const needed = Object.keys(scoring.items).filter(
    (i) => testsOf(scoring.items, i, task).length > 0,
  );
  const rows = await stepRows(dir);
  const delivered = await deliveriesOf(dir, rows, scoring.spec);
  const write = writeOf(rows);
  const seed = new Seed(facts, new Set());
  const boiler = boilerplateStarts(scoring.boilerplate);
  const patterns = needed.flatMap((i) => patternOf(itemOf(scoring.items, i)) ?? []);
  const found: LaterScore["found"] = {};
  const tests: Record<string, boolean> = {};
  for (const item of needed.filter((i) => i in TOLD)) {
    const r = recalled(delivered, write, itemOf(scoring.items, item), seed, patterns, boiler);
    found[item] = r.recalled ? (r.via === "hook" ? "brief" : "search") : null;
    tests[item] = testsOf(scoring.items, item, task).every((t) => judged?.tests[t] === "passed");
  }
  return { ...(await spendOrZero(dir)), capped, passed: judged?.passed ?? false, tests, found };
}

async function modelLineOf(dir: string): Promise<string | null> {
  const log = await readFile(join(dir, "server.log"), "utf8").catch(() => "");
  return (
    log
      .split("\n")
      .filter((l) => l.startsWith("suite: /api/capabilities"))
      .at(-1) ?? null
  );
}

async function armScore(
  folder: string,
  unit: UnitRecord,
  arm: Arm,
  scoring: Scoring,
): Promise<ArmScore> {
  const record = unit.arms[arm];
  const at = (role: string): string => join(folder, "cases", `u${unit.unit}-${arm}-${role}`);
  const facts = existsSync(join(at("E"), "facts.json"))
    ? await load<StoreFact[]>(join(at("E"), "facts.json"))
    : [];
  const capped = (s: { end: { kind: string } } | undefined): boolean => s?.end.kind === "capped";
  const later = {} as Record<Later, LaterScore | null>;
  for (const task of LATER) {
    const ran = record.later[task]?.startedMs != null;
    later[task] = ran
      ? await laterScore(at(task), task, facts, capped(record.later[task]), scoring)
      : null;
  }
  const sessions = [record.earlier, ...LATER.map((t) => record.later[t])];
  const ms = sessions.reduce((sum, x) => sum + ((x?.endedMs ?? 0) - (x?.startedMs ?? 0)), 0);
  return {
    minutes: ms / 60_000,
    earlier: { ...(await spendOrZero(at("E"))), capped: capped(record.earlier) },
    later,
    stored:
      arm === "memory"
        ? Object.fromEntries(
            ITEMS.map((i) => [i, stored(facts, new Set(), itemOf(scoring.items, i)).stored]),
          )
        : {},
    modelLine: arm === "memory" ? await modelLineOf(at("E")) : null,
  };
}

const leakedIn = (unit: UnitRecord): boolean =>
  [unit.arms.none.earlier, ...LATER.map((t) => unit.arms.none.later[t])].some(
    (s) => s?.end.kind === "void" && s.end.cause === "baseline",
  );

/** Why a session of a unit is void, in words. */
function voidsOf(unit: UnitRecord): string[] {
  return ARMS.flatMap((arm) => {
    const r = unit.arms[arm];
    return [["E", r.earlier] as const, ...LATER.map((t) => [t, r.later[t]] as const)].flatMap(
      ([role, s]) =>
        s?.end.kind === "void"
          ? [`u${unit.unit} ${arm} ${role}: ${s.end.cause}, ${s.end.detail}`]
          : [],
    );
  });
}

export async function scoreRun(
  folder: string,
  scoring: Scoring,
): Promise<{ meta: RunMeta; units: UnitScore[] }> {
  const run = await load<RunFile>(join(folder, "run.json"));
  const units: UnitScore[] = [];
  for (const unit of run.units) {
    const sessions = ARMS.flatMap((arm) => [
      unit.arms[arm].earlier,
      ...LATER.map((t) => unit.arms[arm].later[t]),
    ]);
    units.push({
      unit: unit.unit,
      void: unit.void,
      voids: voidsOf(unit),
      leaked: leakedIn(unit),
      cappedSessions: sessions.filter((s) => s?.end.kind === "capped").length,
      sessions: sessions.filter((s) => s?.startedMs != null).length,
      arms: {
        memory: await armScore(folder, unit, "memory", scoring),
        none: await armScore(folder, unit, "none", scoring),
      },
    });
  }
  const { build, config, model, harness, hash, minutes } = run;
  const meta = { build, config, model, harness, hash, minutes };
  return { meta, units };
}

/** The rungs of every item of a unit's memory arm: found and used are per item, over the later task that needs it. */
export function rungsOf(unit: UnitScore): Record<string, Rungs> {
  const out: Record<string, Rungs> = {};
  for (const item of ITEMS) {
    const task = LATER.find((t) => unit.arms.memory.later[t]?.found[item] !== undefined);
    const later = task === undefined ? null : unit.arms.memory.later[task];
    out[item] = {
      stored: unit.arms.memory.stored[item] === true,
      found: later?.found[item] ?? null,
      used: later?.tests[item] === true,
    };
  }
  return out;
}
