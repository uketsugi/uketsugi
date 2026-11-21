/**
 * What the figures are read against. A case's own store rewards a long fact: ordering its facts by
 * length alone, the query unread, finds the needed fact in the top 10 more often than either arm.
 * And most queries do not name the fact they were sent for (see `naming.ts`), so a count over all
 * cells mixes a search that could find it by its words with one that could not.
 */
import type { ReplayCase } from "./data.ts";
import { namingOf } from "./naming.ts";

/** The characters a fact holds: its claim, its detail and its question. */
const lengthOf = (fact: ReplayCase["facts"][number]): number =>
  `${fact.claim} ${fact.detail ?? ""} ${fact.question ?? ""}`.length;

/** What a cell is read against: the place of the needed fact in the facts ordered by length, and whether the query names it. */
export interface Baseline {
  /** 1-based place of the first needed fact when the case's facts are ordered longest first (ties in the data's order). */
  readonly lengthPlace: number;
  /** The query shares a specific word with a needed fact. */
  readonly named: boolean;
}

export function baselineOf(entry: ReplayCase, query: string): Baseline {
  const longest = [...entry.facts].sort((a, b) => lengthOf(b) - lengthOf(a));
  const needed = entry.facts.filter((fact) => entry.targets.has(fact.id));
  return {
    lengthPlace: longest.findIndex((fact) => entry.targets.has(fact.id)) + 1,
    named: namingOf(query, needed, entry.facts).specific.length > 0,
  };
}
