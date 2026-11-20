/**
 * The nine knowledge items of the ergo chain that the suite follows (`data/ergo-chain/items.json`):
 * where each is met (`plant`), which tasks need none of it (`gap`), which tests need it (`tests`, by
 * task), and the patterns that find it in text. A *needed cell* is an item and a later task that
 * needs it. Patterns are data: a paraphrase that drops the distinctive words escapes them, so a "no"
 * means "no matching text".
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA } from "./chain.ts";

export interface Item {
  readonly kind: string;
  readonly statement: string;
  /** The tasks where the item is first met (a reversed item has two). */
  readonly plant: readonly string[];
  /** Tasks, in order, that need none of the item. */
  readonly gap: readonly string[];
  /** The hidden tests that need the item, by task. */
  readonly tests: Readonly<Record<string, readonly string[]>>;
  readonly pattern: string;
  /** The value a reversed item had before: delivering only this is a miss. */
  readonly old?: string;
}

export type Items = Readonly<Record<string, Item>>;

export async function loadItems(): Promise<Items> {
  return JSON.parse(await readFile(join(DATA, "items.json"), "utf8")) as Items;
}

export const taskNumber = (task: string): number => Number(task.slice(1));

/** The compiled pattern of an item (`old` for a reversed item's earlier value), or undefined. */
export function patternOf(item: Item, key: "pattern" | "old" = "pattern"): RegExp | undefined {
  const source = item[key];
  return source === undefined ? undefined : new RegExp(source, "i");
}

/** Every later task that needs the item: its tests after its last plant task. */
export function probeTasks(item: Item): string[] {
  const last = Math.max(...item.plant.map(taskNumber));
  return Object.keys(item.tests)
    .filter((t) => taskNumber(t) > last)
    .sort((a, b) => taskNumber(a) - taskNumber(b));
}

/** {task: the items that need it}: kept with a case so that it can be scored from what it left. */
export function needs(items: Items, tasks: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(
    tasks.map((t) => [t, Object.keys(items).filter((i) => items[i]?.tests[t] !== undefined)]),
  );
}
