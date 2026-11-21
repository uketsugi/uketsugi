/**
 * Whether the brief a session would have had for a store holds a needed fact. The brief is the
 * product's own (the first result of a new session carries it); what is judged here is whether a
 * fact it lists says what the item says once its claim is cut to a line of `cut` characters.
 */
import type { Brief } from "@uketsugi/contracts";
import { labelOf, type Label, type ReplayFact } from "./data.ts";

/**
 * The cuts of a brief's claim the replay judges. The product's brief cuts at 300 (`BRIEF_CLAIM_CHARS`
 * in core's brief.ts, not exported), so `listed` is the real brief at 300 and the 300 column is exact;
 * the 170 column, the earlier cut, is a bound: a shorter cut would list more facts.
 */
export const CUTS = [170, 300] as const;

export interface BriefHold {
  /** A needed fact is on the brief's lines at all, whatever its claim's cut. */
  readonly listed: boolean;
  /** For each cut, a listed needed fact whose claim says the item within it. */
  readonly within: Readonly<Record<number, boolean>>;
}

const collapsed = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Whether the fact's claim says the item inside a line of `cut` characters (a line keeps `cut - 1`).
 * A label with a recorded stretch needs it inside the claim and inside the cut; a label without one
 * counts as said whenever the fact is listed, since the reading did not record where it is said.
 */
export function saysWithin(fact: ReplayFact, label: Label | undefined, cut: number): boolean {
  if (label?.stretch == null) return true;
  const found = new RegExp(label.stretch).exec(collapsed(fact.claim));
  return found !== null && found.index + found[0].length <= cut - 1;
}

/** The ids on a brief's lines: the previous session's facts, then the standing ones. */
function listedIds(brief: Brief | undefined): Set<string> {
  const last = brief?.last_session;
  const lines = [...(last?.published ?? []), ...(last?.digested ?? []), ...(brief?.facts ?? [])];
  return new Set(lines.map((fact) => fact.id));
}

export function briefHolds(
  brief: Brief | undefined,
  targets: ReadonlyMap<string, ReplayFact>,
  labels: ReadonlyMap<string, Label>,
): BriefHold {
  const ids = listedIds(brief);
  const listed = [...targets].filter(([id]) => ids.has(id));
  const within = Object.fromEntries(
    CUTS.map((cut) => [
      cut,
      listed.some(([, fact]) => saysWithin(fact, labelOf(labels, fact.id), cut)),
    ]),
  );
  return { listed: listed.length > 0, within };
}
