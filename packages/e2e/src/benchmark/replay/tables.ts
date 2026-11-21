/**
 * Two tables of the report that read the rows across cells: whether the query names the missed fact
 * (a specific word shared, apart from whether a pass admitted it), told items against asides, and
 * what the figures become with each fitted value relaxed.
 */
import type { Miss } from "./causes.ts";
import { GENERIC_SHARE, specificAt } from "./naming.ts";
import { VARIANTS } from "./profile.ts";
import type { CellRow } from "./replay.ts";
import { count, inTop, TOLD, TOP } from "./figures.ts";

const named = (miss: Miss): boolean => miss.naming.specific.length > 0;
const causeOf = (miss: Miss): string => miss.cause;

/** Misses of a set of rows, with the miss. */
function missesOf(rows: readonly CellRow[]): { row: CellRow; miss: Miss }[] {
  return rows.flatMap((row) => (row.miss === null ? [] : [{ row, miss: row.miss }]));
}

/** `not named a (outranked x, value y, query z); named b (...)` for a set of misses. */
function split(misses: readonly { miss: Miss }[]): string {
  const part = (yes: boolean): string => {
    const own = misses.filter((entry) => named(entry.miss) === yes);
    const causes = ["outranked", "value", "query"].map(
      (name) => `${name} ${count(own, (entry) => causeOf(entry.miss) === name)}`,
    );
    return `${yes ? "named" : "not named"} ${own.length} (${causes.join(", ")})`;
  };
  return `${part(false)}; ${part(true)}`;
}

/** How many misses name no specific word when "generic" is half, as shown, and double the share. */
function notNamedRange(misses: readonly { miss: Miss }[]): string {
  const at = (limit: number): number =>
    count(misses, (entry) => specificAt(entry.miss.naming.shared, limit).length === 0);
  const shares = [GENERIC_SHARE / 2, GENERIC_SHARE, GENERIC_SHARE * 2];
  return shares.map((limit) => `${Math.round(limit * 1000) / 10}%: ${at(limit)}`).join(", ");
}

export function namingLines(rows: readonly CellRow[]): string[] {
  const misses = missesOf(rows);
  const told = misses.filter((entry) => TOLD.has(entry.row.item));
  const asides = misses.filter((entry) => !TOLD.has(entry.row.item));
  const judged = count(misses, (entry) => entry.miss.naming.judgement);
  return [
    `does the query name the fact (shares a specific word), all ${misses.length} misses: ${split(misses)} · ${judged} marked judgement`,
    `  told items, ${told.length} misses: ${split(told)} · not named at a generic share of ${notNamedRange(told)}`,
    `  asides, ${asides.length} misses: ${split(asides)} · not named at a generic share of ${notNamedRange(asides)}`,
  ];
}

export function relaxedLines(rows: readonly CellRow[]): string[] {
  const cells = rows.length;
  const used = VARIANTS.filter((variant) => rows.some((row) => variant in row.relaxed));
  const within = (row: CellRow, variant: string): boolean => {
    const place = row.relaxed[variant];
    return place !== undefined && place !== null && place <= TOP;
  };
  const figures = used.map((variant) => `${variant} ${count(rows, (row) => within(row, variant))}`);
  const misses = rows.filter((row) => !inTop(row));
  const single = used.filter((variant) => variant !== "all relaxed");
  const movedBy = single.map(
    (variant) => `${variant} ${count(misses, (row) => within(row, variant))}`,
  );
  const byAny = count(misses, (row) => single.some((variant) => within(row, variant)));
  const left = misses.filter((row) => !within(row, "all relaxed"));
  const leftNotNamed = count(left, (row) => row.miss !== null && !named(row.miss));
  return [
    `top 10 of ${cells} cells with each fitted value relaxed in turn (as run: ${count(rows, inTop)}): ${figures.join(", ")}`,
    `  misses moved into the top 10 (of ${misses.length}) by: ${movedBy.join(", ")}; by any one of them ${byAny}; by all together ${misses.length - left.length}; left outside with all relaxed ${left.length}, of which the query names no specific word ${leftNotNamed}`,
  ];
}

/** The figures beside the order of length alone, and on the cells whose query names a needed fact and on the rest. */
export function baselineLines(rows: readonly CellRow[]): string[] {
  const byLength = (set: readonly CellRow[]): number =>
    count(set, (row) => row.baseline.lengthPlace >= 1 && row.baseline.lengthPlace <= TOP);
  const part = (name: string, set: readonly CellRow[]): string =>
    `${name} ${set.length} cells: top 10 in ${count(set, inTop)}, length alone ${byLength(set)}`;
  return [
    `length alone (the case's facts longest first, the query unread): needed fact in the top 10 in ${byLength(rows)} of ${rows.length}`,
    `by whether the query names a needed fact (shares a specific word): ${part(
      "named",
      rows.filter((row) => row.baseline.named),
    )}; ${part(
      "not named",
      rows.filter((row) => !row.baseline.named),
    )}`,
  ];
}
