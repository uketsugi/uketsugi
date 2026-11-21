/**
 * What a case cost, from its request log (`requests.jsonl`, one line a model call that the forwarder
 * saw, each with the usage its response ended with). The log is the whole spend: a quick probe is
 * ended at its first write, before the harness reports its tokens, and its calls are all here.
 * Prices are dollars per million tokens, from `handoff/tools/benefit/prices.json`: the Haiku row for
 * a Haiku model, the Claude row for any other Claude model, and the model step's own row.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Usage } from "./forwarder.ts";

const PRICES = {
  claude: { input: 2.0, cache_write: 4.0, cache_read: 0.1, output: 10.0 },
  claude_haiku: { input: 0.1, cache_write: 0.2, cache_read: 0.01, output: 0.5 },
  llm: { input: 0.25, cache_write: 0.25, cache_read: 0.25, output: 1.5 },
} as const;

export type PriceRow = keyof typeof PRICES;

/** A call that failed or was cut short has no usage: its fields are zero. */
export const usdOf = (usage: Partial<Usage>, row: PriceRow): number => {
  const p = PRICES[row];
  return (
    ((usage.input ?? 0) * p.input +
      (usage.cache_write ?? 0) * p.cache_write +
      (usage.cache_read ?? 0) * p.cache_read +
      (usage.output ?? 0) * p.output) /
    1e6
  );
};

export interface Spend {
  readonly tokens: number;
  readonly usd: number;
}

/** The tokens and dollars of every model call in a case's request log, the killed probes' included. */
export async function spendOf(out: string): Promise<Spend> {
  let tokens = 0;
  let usd = 0;
  for (const line of (await readFile(join(out, "requests.jsonl"), "utf8")).split("\n")) {
    if (line.trim() === "") continue;
    const call = JSON.parse(line) as { model?: string | null; usage: Partial<Usage> };
    const { usage } = call;
    tokens +=
      (usage.input ?? 0) + (usage.cache_write ?? 0) + (usage.cache_read ?? 0) + (usage.output ?? 0);
    usd += usdOf(usage, call.model?.includes("haiku") === true ? "claude_haiku" : "claude");
  }
  return { tokens, usd };
}
