/** What the report counts rows with. */
import type { BriefRow, CellRow } from "./replay.ts";

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

/** Items a person told the agent (a rule, a decision, something for later); D8 and D12 are asides the agent found. */
export const TOLD = new Set(["D1", "D2", "D3", "D5", "P1"]);

/** The brief's figures of a set of cells: a needed fact listed, and said within each cut. */
export function briefCounts(rows: readonly BriefRow[], cuts: readonly number[]): string {
  const within = cuts.map((cut) => `${cut}: ${count(rows, (r) => r.brief.within[cut] === true)}`);
  return `listed ${count(rows, (r) => r.brief.listed)} of ${rows.length}; saying the item within ${within.join(", ")}`;
}

/** The brief's length over the cases (a brief is one per case, shared by its cells). */
export function briefLength(rows: readonly BriefRow[]): string {
  const byCase = new Map(rows.map((row) => [row.case, row.brief.chars]));
  const lengths = [...byCase.values()];
  const mean = lengths.reduce((sum, n) => sum + n, 0) / Math.max(1, lengths.length);
  return `${lengths.length} cases, mean ${mean.toFixed(1)} characters, longest ${Math.max(0, ...lengths)}`;
}
