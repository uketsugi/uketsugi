/**
 * Recall with its interval, and what a comparison can show. Every interval is a bootstrap over the
 * items: the items are resampled with replacement, each carrying all its cells and repeats, so the
 * item-to-item spread (some items are far harder than others) is in it and the cells of one item are
 * never treated as independent.
 */
const DRAWS = 2000;
const LEVEL = 0.9;

/** {item: [cells recalled, cells]}. */
export type PerItem = Readonly<Record<string, readonly [number, number]>>;

/** A small seeded generator (mulberry32): the same data gives the same interval. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rate(perItem: PerItem, picks: readonly string[]): number | undefined {
  let hits = 0;
  let cells = 0;
  for (const i of picks) {
    hits += perItem[i]?.[0] ?? 0;
    cells += perItem[i]?.[1] ?? 0;
  }
  return cells > 0 ? hits / cells : undefined;
}

function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[at] as number;
}

const resample = (items: readonly string[], next: () => number): string[] =>
  items.map(() => items[Math.floor(next() * items.length)] as string);

/** The recall rate's interval over `perItem`, or undefined when no cell was measured. */
export function interval(perItem: PerItem): [number, number] | undefined {
  const items = Object.keys(perItem).filter((i) => (perItem[i]?.[1] ?? 0) > 0);
  if (items.length === 0) return undefined;
  const next = generator(0);
  const rates: number[] = [];
  for (let d = 0; d < DRAWS; d++) {
    const r = rate(perItem, resample(items, next));
    if (r !== undefined) rates.push(r);
  }
  return [percentile(rates, (1 - LEVEL) / 2), percentile(rates, 1 - (1 - LEVEL) / 2)];
}

export interface Difference {
  items: string[];
  change: number;
  low: number;
  high: number;
  shown: boolean;
}

/** The change in recall from `old` to `next` over the items in both, paired by item; `shown` is false when its interval spans zero. */
export function difference(old: PerItem, now: PerItem): Difference | undefined {
  const items = Object.keys(now).filter((i) => (old[i]?.[1] ?? 0) > 0 && (now[i]?.[1] ?? 0) > 0);
  if (items.length === 0) return undefined;
  const next = generator(0);
  const diffs: number[] = [];
  for (let d = 0; d < DRAWS; d++) {
    const picks = resample(items, next);
    diffs.push((rate(now, picks) as number) - (rate(old, picks) as number));
  }
  const low = percentile(diffs, (1 - LEVEL) / 2);
  const high = percentile(diffs, 1 - (1 - LEVEL) / 2);
  const change = (rate(now, items) as number) - (rate(old, items) as number);
  return { items: [...items].sort(), change, low, high, shown: low > 0 || high < 0 };
}
