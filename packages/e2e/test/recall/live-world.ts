/**
 * Made-up evidence of a live run, in the layout a run keeps: `run.json`, and a case folder per
 * session with the store when E ended, the steps, the transcripts, the judge's files, the request
 * log and the server's log. A unit says, per arm, what E stored, what L was handed and what passed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { End } from "../../src/recall/ending.ts";
import type { Item, Items } from "../../src/recall/items.ts";
import type { Scoring } from "../../src/live/score.ts";
import type { ArmRecord, SessionRecord, UnitRecord } from "../../src/live/pair.ts";
import { search } from "./world.ts";

const item = (task: string, test: string): Item => ({
  kind: "person",
  statement: "s",
  plant: ["T1"],
  gap: [],
  tests: { [task]: [`t::${test}`] },
  pattern: `marker-${test}`,
});

export const ITEMS: Items = {
  D1: item("T4", "D1"),
  D2: item("T4", "D2"),
  D3: item("T4", "D3"),
  D8: item("T4", "D8"),
  P1: item("T8", "P1"),
};

export const SCORING: Scoring = {
  items: ITEMS,
  spec: { call: ["^mcp__uketsugi__"], touch: ["uketsugi"] },
  boilerplate: [],
};

export interface ArmSpec {
  /** Items E's store holds. */
  stored?: string[];
  /** Items L was handed by a search, by later task. */
  found?: { T4?: string[]; T8?: string[] };
  /** Items whose tests passed at the end of L, by task; the task passes when `all` is true. */
  passed?: { T4?: string[]; T8?: string[] };
  taskPasses?: { T4?: boolean; T8?: boolean };
  /** Tokens of E and of each later session. */
  tokens?: { E?: number; T4?: number; T8?: number };
  end?: { E?: End; T4?: End; T8?: End };
  model?: boolean;
  /** Facts E stored that state none of the five items. */
  other?: string[];
  /** Which of `other` (by index) L was handed by a search, by later task. */
  foundOther?: { T4?: number[]; T8?: number[] };
}

const ALL_ITEMS = ["D1", "D2", "D3", "D8", "P1"];
const DONE: End = { kind: "done" };
const at = (end: End): SessionRecord => ({
  startedMs: end.kind === "void" ? null : 0,
  endedMs: end.kind === "void" ? null : 600_000,
  end,
});

function writeCase(dir: string, files: Record<string, string>): void {
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  mkdirSync(join(dir, "judge"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

const requests = (tokens: number): string =>
  JSON.stringify({
    model: "claude-haiku-4-5",
    usage: { input: tokens, cache_write: 0, cache_read: 0, output: 0 },
  }) + "\n";

/** The store when E ended: a fact for each stored item, and the others. */
const factsOf = (spec: ArmSpec): { id: string; claim: string }[] => [
  ...(spec.stored ?? []).map((i) => ({
    id: `f-${i}`,
    claim: `marker-${i} is what the person told us`,
  })),
  ...(spec.other ?? []).map((claim, n) => ({ id: `o-${n}`, claim })),
];

/** The facts L was handed by a search: those of the items named, and those of `other` named by index. */
const handedOf = (spec: ArmSpec, task: "T4" | "T8"): { id: string; claim: string }[] => [
  ...(spec.found?.[task] ?? []).map((i) => ({
    id: `g-${i}`,
    claim: `marker-${i} is what the person told us`,
  })),
  ...(spec.foundOther?.[task] ?? []).map((n) => ({
    id: `o-${n}`,
    claim: (spec.other ?? [])[n] as string,
  })),
];

function writeArm(folder: string, unit: number, arm: "memory" | "none", spec: ArmSpec): ArmRecord {
  const dir = (role: string): string => join(folder, "cases", `u${unit}-${arm}-${role}`);
  const tokens = { E: 1e6, T4: 2e6, T8: 2e6, ...spec.tokens };
  writeCase(dir("E"), {
    "facts.json": JSON.stringify(factsOf(spec)),
    "steps.jsonl": "",
    "requests.jsonl": requests(tokens.E),
    "server.log":
      arm === "memory" && spec.model !== false ? "suite: /api/capabilities degraded=[]\n" : "",
  });
  const later: Partial<Record<"T4" | "T8", SessionRecord>> = {};
  for (const task of ["T4", "T8"] as const) {
    const end = spec.end?.[task] ?? DONE;
    later[task] = at(end);
    if (end.kind === "void") continue;
    const handed = handedOf(spec, task);
    const judged = {
      passed: spec.taskPasses?.[task] === true,
      tests: Object.fromEntries((spec.passed?.[task] ?? []).map((i) => [`t::${i}`, "passed"])),
    };
    writeCase(dir(task), {
      "steps.jsonl":
        JSON.stringify({
          session: "L",
          step: 0,
          kind: "task",
          task,
          transcript: "transcripts/L.0.jsonl",
          killed: false,
          first_write: null,
        }) + "\n",
      "transcripts/L.0.jsonl": search(`s-${task}`, {
        facts: handed,
        degraded: [],
      }),
      [`judge/L.${task}.0.json`]: JSON.stringify(judged),
      "requests.jsonl": requests(tokens[task]),
    });
  }
  return {
    phases: [],
    earlier: at(spec.end?.E ?? DONE),
    later,
    carried: { memory: [], instructions: [] },
  };
}

export interface UnitSpec {
  memory: ArmSpec;
  none: ArmSpec;
}

/** Writes a run's folder: its units' case folders and `run.json`. */
export function writeRun(folder: string, units: UnitSpec[], hash = "h1", build = "b1"): void {
  const records: UnitRecord[] = units.map((spec, n) => {
    const arms = {
      memory: writeArm(folder, n + 1, "memory", spec.memory),
      none: writeArm(folder, n + 1, "none", spec.none),
    };
    const isVoid = Object.values(arms).some((a) =>
      [a.earlier, ...Object.values(a.later)].some((s) => s.end.kind === "void"),
    );
    return { unit: n + 1, arms, void: isVoid };
  });
  writeFileSync(
    join(folder, "run.json"),
    JSON.stringify({
      build,
      config: "setup",
      model: "haiku",
      harness: "2.1.0",
      hash,
      minutes: 41.6,
      units: records,
    }),
  );
}

export { ALL_ITEMS };
