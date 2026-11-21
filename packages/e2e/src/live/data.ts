/**
 * The live test's data, beside the ergo chain's (`data/ergo-chain/live.json`): the reworded T1 and
 * T2 entries, in the shape of `chain.json`'s tasks, which replace those of `chain.json` for the live
 * test only (the recall suite keeps its own); and `told`, how each item is said to the earlier
 * session: outright as a standing rule, in passing, or not said and found by the agent (design
 * section 1). The ladder of the report is kept apart by it.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA, loadChain, type ChainData, type Task } from "../recall/chain.ts";

export type Told = "outright" | "passing" | "found";
const KINDS: readonly string[] = ["outright", "passing", "found"];

interface LiveFile {
  readonly told: Readonly<Record<string, string>>;
  readonly T1: Task;
  readonly T2: Task;
}

/** Why `told` is not the right shape, or undefined: every item of the live test is named once, with a kind. */
export function toldProblem(
  told: Readonly<Record<string, string>>,
  items: readonly string[],
): string | undefined {
  const bad = Object.entries(told).filter(([, kind]) => !KINDS.includes(kind));
  if (bad.length > 0)
    return `told has kinds that are not ${KINDS.join(", ")}: ${bad.map(([i]) => i).join(", ")}`;
  const missing = items.filter((i) => !(i in told));
  const extra = Object.keys(told).filter((i) => !items.includes(i));
  if (missing.length + extra.length > 0)
    return `told must name exactly the live items (${items.join(", ")}): missing ${missing.join(", ") || "none"}, extra ${extra.join(", ") || "none"}`;
  return undefined;
}

const read = (): LiveFile => JSON.parse(readFileSync(join(DATA, "live.json"), "utf8")) as LiveFile;

/** How each item is said, from `live.json`. */
export const TOLD = read().told as Readonly<Record<string, Told>>;
/** The items of the live test, in the order of `told`. */
export const ITEMS: readonly string[] = Object.keys(TOLD);

/** The ergo chain with the live test's T1 and T2. */
export async function loadLiveChain(): Promise<ChainData> {
  const chain = await loadChain();
  const live = JSON.parse(await readFile(join(DATA, "live.json"), "utf8")) as LiveFile;
  return { ...chain, tasks: { ...chain.tasks, T1: live.T1, T2: live.T2 } };
}
