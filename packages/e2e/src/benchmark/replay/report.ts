/**
 * What the replay prints: for each store shape and arm the figures, the table of causes, the brief,
 * the labels the result carries, and one line for every miss. Deterministic: rows in case order.
 */
import { CUTS } from "./brief.ts";
import type { Miss } from "./causes.ts";
import type { Shape } from "./data.ts";
import type { Arm, BriefRow, CellRow } from "./replay.ts";
import { briefCounts, briefLength, count, inTop, TOLD, tally, TOP } from "./figures.ts";
import { baselineLines, namingLines, relaxedLines } from "./tables.ts";

/** The figures of memory research's round 3 the replay is judged against (top 10 in a cell's first query). */
export const KEPT_FIGURES: Readonly<Record<string, { top10: number; cells: number }>> = {
  "own/words": { top10: 44, cells: 74 },
  "own/model": { top10: 26, cells: 74 },
  "project/words": { top10: 14, cells: 80 },
  "project/model": { top10: 14, cells: 80 },
};

function perItem(rows: readonly CellRow[]): string {
  const items = [...new Set(rows.map((row) => row.item))].sort();
  return items
    .map((item) => {
      const own = rows.filter((row) => row.item === item);
      return `${item} ${count(own, inTop)}/${own.length}`;
    })
    .join(", ");
}

function causeName(miss: Miss): string {
  return miss.cause === "value" ? `value(${miss.values.join("+")})` : miss.cause;
}

function missLine(row: CellRow, miss: Miss): string {
  const where = row.place === null ? "not in 50" : `place ${row.place}`;
  const control = miss.control === null ? "not in 50" : `${miss.control}`;
  const held = CUTS.map((cut) => `${cut}:${row.brief.within[cut] === true ? "yes" : "no"}`).join(
    " ",
  );
  const why = {
    query: () => "the query does not name it",
    value: () => `admitted when ${miss.values.join(", ")} is relaxed`,
    outranked: () => {
      const passes = Object.entries(miss.ranks)
        .map(([pass, rank]) => `${pass} ${rank}`)
        .join(" ");
      const evidence = `cos ${miss.cosine?.toFixed(2) ?? "-"} cov ${miss.coverage?.toFixed(2) ?? "-"}`;
      const above = miss.above.map(
        (a) =>
          `"${a.claim.slice(0, 40)}" [${Object.entries(a.ranks)
            .map(([p, r]) => `${p} ${r}`)
            .join(" ")}]`,
      );
      return `passes [${passes}] ${evidence}; above: ${above.join(" / ")}`;
    },
  }[miss.cause]();
  const { naming } = miss;
  const words = naming.specific.map((entry) => `${entry.word} ${Math.round(entry.share * 100)}%`);
  const shared = `shares ${naming.shared.length} of ${naming.queryWords} query words, specific [${words.join(", ")}]${naming.judgement ? " (judgement)" : ""}`;
  return `  ${row.case} ${row.task} ${where} · ${causeName(miss)}: ${why} · ${shared} · control ${control} · brief ${held} · listed ${row.brief.listed ? "yes" : "no"}`;
}

/** The brief's figures of one shape, whole and split by told items and asides, and its length. */
export function briefLines(shape: Shape, rows: readonly BriefRow[]): string[] {
  const told = rows.filter((row) => TOLD.has(row.item));
  const asides = rows.filter((row) => !TOLD.has(row.item));
  return [
    `\n== brief · ${shape} store · ${rows.length} cells`,
    `all cells: ${briefCounts(rows, CUTS)}`,
    `  told items (${[...TOLD].join(", ")}): ${briefCounts(told, CUTS)}`,
    `  asides: ${briefCounts(asides, CUTS)}`,
    `brief length: ${briefLength(rows)}`,
  ];
}

/** The section of one shape and arm. */
export function sectionOf(shape: Shape, arm: Arm, rows: readonly CellRow[]): string[] {
  const cells = rows.length;
  const top = count(rows, inTop);
  const mid = count(rows, (r) => r.place !== null && r.place > TOP);
  const kept = KEPT_FIGURES[`${shape}/${arm}`];
  const misses = rows.filter((row) => !inTop(row));
  const withMiss = misses.flatMap((row) => (row.miss === null ? [] : [row.miss]));
  const heldIn = (set: readonly CellRow[], cut: number): number =>
    count(set, (r) => r.brief.within[cut] === true);
  const figure = kept === undefined ? "" : ` (round 3: ${kept.top10} of ${kept.cells})`;
  return [
    `\n== ${shape} store · ${arm === "words" ? "words only" : "with the model"} · ${cells} cells`,
    `needed fact in the top 10: ${top} of ${cells}${figure} · places 11 to 50: ${mid} · not in 50: ${cells - top - mid} · top 3: ${count(rows, (r) => r.place !== null && r.place <= 3)}`,
    `confidence over all cells: ${tally(rows.map((r) => r.confidence))} · over the misses: ${tally(misses.map((r) => r.confidence))}`,
    `per item, top 10 of cells: ${perItem(rows)}`,
    `causes of the ${misses.length} misses (whether a pass admitted the fact): ${tally(withMiss.map(causeName))}`,
    ...baselineLines(rows),
    ...namingLines(rows),
    ...relaxedLines(rows),
    `control (the fact's own claim as the query): top 10 in ${count(withMiss, (m) => m.control !== null && m.control <= TOP)} of ${withMiss.length}`,
    `brief holds a needed fact: listed ${count(rows, (r) => r.brief.listed)} of ${cells}; saying the item within ${CUTS.map((cut) => `${cut}: ${heldIn(rows, cut)}`).join(", ")} · among the misses: listed ${count(misses, (r) => r.brief.listed)} of ${misses.length}; ${CUTS.map((cut) => `${cut}: ${heldIn(misses, cut)}`).join(", ")}`,
    ...briefLines(shape, rows).slice(1),
    ...rows.flatMap((row) => (row.miss === null ? [] : [missLine(row, row.miss)])),
  ];
}
