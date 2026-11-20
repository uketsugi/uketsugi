/**
 * One case scored from what it left in its evidence folder: the same function scores a run just
 * finished and rescores an old one with no new session. The folder holds `chain.json` (the sessions
 * with their roles, which tasks need which items, the items' tests), `arm.json` (which calls are
 * memory's), `steps.jsonl` (each step: its transcript, whether it was killed, its first write),
 * `facts.json` (the store as the first probe found it), `facts-plant.json` (right after the plant),
 * `transcripts/` and `judge/`.
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { deliveriesBy, type MemorySpec, type StoreFact } from "./adapter.ts";
import { patternOf, type Items } from "./items.ts";
import {
  Seed,
  boilerplateStarts,
  recalled,
  stored,
  type Delivered,
  type Stored,
  type Write,
} from "./measure.ts";
import type { Cell } from "./report.ts";
import { parseTranscript } from "./transcript.ts";

export interface StepRow {
  session: string;
  step: number;
  kind: string;
  task?: string | null;
  transcript: string;
  rc?: number | null;
  killed: boolean;
  first_write: { call_line: number; result_line: number; tool: string } | null;
  prompt?: string;
}

interface CaseChain {
  sessions: { id: string; role?: string; steps: { task?: string }[] }[];
  needs: Record<string, string[]>;
  items: Record<string, { kind: string; tests: Record<string, string[]> }>;
}

const load = async <T>(out: string, name: string): Promise<T> =>
  JSON.parse(await readFile(join(out, name), "utf8")) as T;

async function stepRows(out: string): Promise<StepRow[]> {
  const text = await readFile(join(out, "steps.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as StepRow);
}

/** The session's deliveries over its steps' transcripts, in order. */
async function deliveriesOf(
  out: string,
  rows: readonly StepRow[],
  spec: MemorySpec,
): Promise<Delivered[]> {
  const found: Delivered[] = [];
  for (const row of [...rows].sort((a, b) => a.step - b.step)) {
    const transcript = parseTranscript(await readFile(join(out, row.transcript), "utf8"));
    for (const d of deliveriesBy(spec, transcript)) found.push({ ...d, step: row.step });
  }
  return found;
}

/** The session's first write as the runner recorded it: its step and the line of the call. */
function writeOf(rows: readonly StepRow[]): Write | null {
  const row = [...rows].sort((a, b) => a.step - b.step).find((r) => r.first_write !== null);
  return row?.first_write ? { step: row.step, line: row.first_write.call_line } : null;
}

/** Whether the item's tests passed at a probe's first check and at its last (full mode). */
async function usedOf(
  out: string,
  item: string,
  session: string,
  task: string,
  tests: readonly string[],
): Promise<Cell["used"]> {
  const dir = join(out, "judge");
  if (!existsSync(dir)) return null;
  const attempts: { n: number; tests: Record<string, string> }[] = [];
  for (const name of await readdir(dir)) {
    const [sid, t, n] = name.replace(/\.json$/, "").split(".");
    if (sid === session && t === task && n !== undefined) {
      attempts.push({
        n: Number(n),
        tests: (await load<{ tests?: Record<string, string> }>(dir, name)).tests ?? {},
      });
    }
  }
  if (attempts.length === 0 || tests.length === 0) return null;
  attempts.sort((a, b) => a.n - b.n);
  const ok = (t: Record<string, string>): boolean => tests.every((id) => t[id] === "passed");
  return {
    first: ok((attempts[0] as { tests: Record<string, string> }).tests),
    final: ok((attempts.at(-1) as { tests: Record<string, string> }).tests),
  };
}

export interface CaseKey {
  product: string;
  config: string;
  item: string;
  kind: "treatment" | "control";
  repeat: number;
}

export interface Scoring {
  items: Items;
  seedClaims: ReadonlySet<string>;
  boilerplate: readonly string[];
  mode: string;
}

/** The cells of a treatment or control case, one per probe session, and for a treatment the item's `stored`. */
export async function scoreCase(
  out: string,
  key: CaseKey,
  scoring: Scoring,
): Promise<{ cells: Cell[]; stored: Stored | null }> {
  const chain = await load<CaseChain>(out, "chain.json");
  const arm = await load<{ memory: { call: string[]; tool_search?: string; touch: string[] } }>(
    out,
    "arm.json",
  );
  const spec: MemorySpec = {
    call: arm.memory.call,
    touch: arm.memory.touch,
    ...(arm.memory.tool_search === undefined ? {} : { toolSearch: arm.memory.tool_search }),
  };
  const rows = await stepRows(out);
  const facts = await load<StoreFact[]>(out, "facts.json");
  const seed = new Seed(facts, scoring.seedClaims);
  const boiler = boilerplateStarts(scoring.boilerplate);
  const item = scoring.items[key.item];
  if (item === undefined) throw new Error(`no item ${key.item}`);
  const cells: Cell[] = [];
  for (const s of chain.sessions.filter((x) => x.role === "probe")) {
    const task = s.steps[0]?.task as string;
    const mine = rows.filter((r) => r.session === s.id);
    const needed = (chain.needs[task] ?? []).flatMap((i) => {
      const p = scoring.items[i] ? patternOf(scoring.items[i]) : undefined;
      return p === undefined ? [] : [p];
    });
    const result = recalled(
      await deliveriesOf(out, mine, spec),
      writeOf(mine),
      item,
      seed,
      needed,
      boiler,
    );
    const full = scoring.mode === "full" && key.kind === "treatment";
    cells.push({
      ...key,
      task,
      session: s.id,
      recalled: result,
      used: full
        ? await usedOf(out, key.item, s.id, task, chain.items[key.item]?.tests[task] ?? [])
        : null,
    });
  }
  const plant = existsSync(join(out, "facts-plant.json"))
    ? await load<StoreFact[]>(out, "facts-plant.json")
    : facts;
  return {
    cells,
    stored: key.kind === "treatment" ? stored(plant, scoring.seedClaims, item) : null,
  };
}

/** Tokens of a case's transcripts (input, cache writes and reads, output), from each step's result event. */
export async function tokensOf(out: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(join(out, "transcripts"))) {
    if (!name.endsWith(".jsonl")) continue;
    for (const line of (await readFile(join(out, "transcripts", name), "utf8")).split("\n")) {
      try {
        const d = JSON.parse(line) as { type?: string; usage?: Record<string, number> };
        if (d.type === "result") {
          for (const k of [
            "input_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
            "output_tokens",
          ])
            total += d.usage?.[k] ?? 0;
        }
      } catch {
        // not an event
      }
    }
  }
  return total;
}
