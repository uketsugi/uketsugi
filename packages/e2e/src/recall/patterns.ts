/** The check every run makes before it starts: no item's pattern may match what no earlier session put there. */
import type { Adapter } from "./adapter.ts";
import { seedOf } from "./case.ts";
import type { Items } from "./items.ts";
import { validatePatterns } from "./measure.ts";

/** Refuses to start when an item's pattern matches the seed or the product's boilerplate. */
export async function refuseBrokenPatterns(adapter: Adapter, items: Items): Promise<void> {
  const seed = (await seedOf()) as { claim: string; detail?: string }[];
  const problems = validatePatterns(items, seed, adapter.boilerplate);
  if (problems.length > 0) {
    throw new Error(
      `refusing to start: an item's pattern matches what no earlier session put there:\n${problems.join("\n")}`,
    );
  }
}
