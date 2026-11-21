/** What the report counts rows with. */
import type { CellRow } from "./replay.ts";

export const TOP = 10;
export const count = <T>(items: readonly T[], test: (item: T) => boolean): number =>
  items.filter(test).length;
export const inTop = (row: CellRow): boolean => row.place !== null && row.place <= TOP;
export const tally = (names: readonly string[]): string => {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return (
    [...counts]
      .sort()
      .map(([name, n]) => `${name} ${n}`)
      .join(", ") || "none"
  );
};
