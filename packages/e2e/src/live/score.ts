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
import { factsStating, labelProblems, readLabels, type Labels } from "./labels.ts";
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
  /** The memory arm's store by the patterns alone, item by item; empty for the other arm. */
  readonly storedByPatterns: Record<string, boolean>;
  /** How many stored facts the hand labels cover; null when the run has no labels. */
  readonly labelled: number | null;
  /** The claims of the facts E stored that matched no item: what "not stored" rests on, since a pattern misses some paraphrase. */
  readonly unmatched: readonly string[];
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
  stating?: (item: string) => readonly StoreFact[],
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
    const base = itemOf(scoring.items, item);
    const r = recalled(
      delivered,
      write,
      stating === undefined ? base : byFacts(base, stating(item)),
      seed,
      patterns,
      boiler,
    );
    found[item] = r.recalled ? (r.via === "hook" ? "brief" : "search") : null;
    tests[item] = testsOf(scoring.items, item, task).every((t) => judged?.tests[t] === "passed");
  }
  return { ...(await spendOrZero(dir)), capped, passed: judged?.passed ?? false, tests, found };
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The item with its pattern replaced by the facts the labels say state it: found when one of them is delivered (by its id or the start of its claim). */
function byFacts(item: Item, facts: readonly StoreFact[]): Item {
  const source =
    facts.length === 0
      ? "(?!)"
      : facts.map((f) => `${escape(f.id)}|${escape(f.claim.slice(0, 50))}`).join("|");
  return { ...item, pattern: source };
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

/** The facts none of the five items' patterns matches, by their claims. */
function unmatchedOf(
  facts: readonly StoreFact[],
  items: Items,
  stating?: (f: StoreFact) => boolean,
): string[] {
  if (stating !== undefined) return facts.filter((f) => !stating(f)).map((f) => f.claim);
  const patterns = ITEMS.map((i) => patternOf(itemOf(items, i)) as RegExp);
  return facts
    .filter((f) => {
      const text = [f.claim, f.detail ?? "", f.question ?? ""].join(" ");
      return !patterns.some((rx) => rx.test(text));
    })
    .map((f) => f.claim);
}

async function armScore(
  folder: string,
  unit: UnitRecord,
  arm: Arm,
  scoring: Scoring,
  labels?: Labels,
): Promise<ArmScore> {
  const record = unit.arms[arm];
  const at = (role: string): string => join(folder, "cases", `u${unit.unit}-${arm}-${role}`);
  const facts = existsSync(join(at("E"), "facts.json"))
    ? await load<StoreFact[]>(join(at("E"), "facts.json"))
    : [];
  const capped = (s: { end: { kind: string } } | undefined): boolean => s?.end.kind === "capped";
  const stating =
    labels === undefined || arm !== "memory"
      ? undefined
      : (item: string): readonly StoreFact[] => factsStating(labels, unit.unit, facts, item);
  const byPatterns = Object.fromEntries(
    ITEMS.map((i) => [i, stored(facts, new Set(), itemOf(scoring.items, i)).stored]),
  );
  const later = {} as Record<Later, LaterScore | null>;
  for (const task of LATER) {
    const ran = record.later[task]?.startedMs != null;
    later[task] = ran
      ? await laterScore(at(task), task, facts, capped(record.later[task]), scoring, stating)
      : null;
  }
  const sessions = [record.earlier, ...LATER.map((t) => record.later[t])];
  const ms = sessions.reduce((sum, x) => sum + ((x?.endedMs ?? 0) - (x?.startedMs ?? 0)), 0);
  return {
    unmatched:
      arm !== "memory"
        ? []
        : unmatchedOf(
            facts,
            scoring.items,
            labels === undefined ? undefined : (f) => ITEMS.some((i) => stating?.(i).includes(f)),
          ),
    storedByPatterns: arm === "memory" ? byPatterns : {},
    labelled: arm === "memory" && labels !== undefined ? facts.length : null,
    minutes: ms / 60_000,
    earlier: { ...(await spendOrZero(at("E"))), capped: capped(record.earlier) },
    later,
    stored:
      arm !== "memory"
        ? {}
        : stating === undefined
          ? byPatterns
          : Object.fromEntries(ITEMS.map((i) => [i, stating(i).length > 0])),
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

/** Refuses labels that name a fact the run did not store, or leave a stored fact out. */
async function refuseBadLabels(folder: string, run: RunFile, labels: Labels): Promise<void> {
  const stores: Record<number, StoreFact[]> = {};
  for (const u of run.units) {
    const path = join(folder, "cases", `u${u.unit}-memory-E`, "facts.json");
    stores[u.unit] = existsSync(path) ? await load<StoreFact[]>(path) : [];
  }
  const problems = labelProblems(labels, stores);
  if (problems.length > 0) throw new Error(`the labels file is refused:\n${problems.join("\n")}`);
}

export async function scoreRun(
  folder: string,
  scoring: Scoring,
): Promise<{ meta: RunMeta; units: UnitScore[] }> {
  const run = await load<RunFile>(join(folder, "run.json"));
  const labels = await readLabels(folder);
  if (labels !== undefined) await refuseBadLabels(folder, run, labels);
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
        memory: await armScore(folder, unit, "memory", scoring, labels),
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
