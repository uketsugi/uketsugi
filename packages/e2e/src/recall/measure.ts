/**
 * The measures of one case, each with the lines that show it.
 *
 * - **recalled** (the headline): in a probe, before its first write to the tree, memory delivered
 *   (a hook's output or a memory call's result, decoded) a record that matches the item and is
 *   neither a seed fact's nor the product's boilerplate: what an earlier session put there.
 * - **stored**: after the plant, a fact of the store that is not the seed's and matches the item;
 *   by the agent or by the product's own capture.
 * - **used**: the item's own hidden tests pass in the probe (full mode).
 * A match is a regex: a paraphrase can escape it.
 */
import { splitLines } from "./transcript.ts";
import type { Delivery } from "./transcript.ts";
import { patternOf, type Item, type Items } from "./items.ts";
import type { StoreFact } from "./adapter.ts";

const CONTEXT = 90;
/** How much of a claim marks a record as the seed's: a brief cuts claims short. */
const PREFIX = 30;
/** A record shorter than this is no fact. */
const MIN_RECORD = 20;

export const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

const chars = (text: string): number => [...text].length;

function excerpt(text: string, match: RegExpExecArray): string {
  const around = text.slice(
    Math.max(0, match.index - CONTEXT),
    match.index + match[0].length + CONTEXT,
  );
  return around.replace(/\s+/g, " ").trim();
}

/** What marks a record as the seed's: the id of a seed fact, or the start of a seed claim. */
export class Seed {
  private readonly ids: Set<string>;
  private readonly starts: Set<string>;

  constructor(facts: readonly { id: string; claim: string }[], claims: ReadonlySet<string>) {
    this.ids = new Set(facts.filter((f) => claims.has(f.claim)).map((f) => f.id));
    this.starts = new Set([...claims].map((c) => squash(c).slice(0, PREFIX)));
  }

  has(record: string): boolean {
    const flat = squash(record);
    return (
      [...this.ids].some((i) => record.includes(i)) ||
      [...this.starts].some((s) => flat.includes(s))
    );
  }
}

export function boilerplateStarts(lines: readonly string[]): string[] {
  return lines.filter((l) => l.trim() !== "").map((l) => squash(l).slice(0, PREFIX));
}

/** The records of a delivery that are neither the seed's nor the product's own boilerplate. */
export function keptRecords(text: string, seed: Seed, boiler: readonly string[]): string[] {
  return splitLines(text).filter(
    (r) =>
      chars(r.trim()) > MIN_RECORD && !seed.has(r) && !boiler.some((b) => squash(r).includes(b)),
  );
}

export interface Hit {
  readonly via: string;
  readonly call: string;
  readonly evidence: string;
}

export interface Recalled {
  recalled: boolean;
  late: boolean;
  via: string | null;
  call: string | null;
  evidence: string[];
  old_value_delivered: boolean;
  delivered_chars: number;
  delivered_records: number;
  unneeded_records: number;
  wrote: boolean;
}

/** A session's first write: the step and the transcript line of the call after which its tree differed. */
export interface Write {
  readonly step: number;
  readonly line: number;
}

/** A delivery with the step of the session it came in. */
export interface Delivered extends Delivery {
  readonly step: number;
}

const modeOf = (d: Delivered): string => (d.via === "hook" ? "hook" : "search");

/** Before the first write: in an earlier step, or earlier in the same step than the call that wrote. */
export function inTime(d: Delivered, write: Write | null): boolean {
  return write === null || d.step < write.step || (d.step === write.step && d.line < write.line);
}

/** What one pass over a probe's deliveries keeps. */
class Scan {
  hit: Hit | undefined;
  late: Hit | undefined;
  oldSeen = false;
  characters = 0;
  records = 0;
  unneeded = 0;

  private readonly rx: RegExp;
  private readonly old: RegExp | undefined;
  private readonly needed: readonly RegExp[];

  constructor(rx: RegExp, old: RegExp | undefined, needed: readonly RegExp[]) {
    this.rx = rx;
    this.old = old;
    this.needed = needed;
  }

  delivery(d: Delivered, timely: boolean, kept: readonly string[]): void {
    this.oldSeen ||= this.old !== undefined && timely && kept.some((r) => this.old?.test(r));
    if (timely) {
      this.characters += chars(d.text);
      this.records += kept.length;
      this.unneeded += kept.filter((r) => !this.needed.some((n) => n.test(r))).length;
    }
    for (const r of kept) {
      const m = this.rx.exec(r);
      if (m === null) continue;
      const found = { via: modeOf(d), call: d.name, evidence: excerpt(r, m) };
      if (timely) this.hit ??= found;
      else this.late ??= found;
    }
  }
}

export function recalled(
  deliveries: readonly Delivered[],
  write: Write | null,
  item: Item,
  seed: Seed,
  needed: readonly RegExp[],
  boiler: readonly string[],
): Recalled {
  const rx = patternOf(item);
  if (rx === undefined) throw new Error("an item has no pattern");
  const scan = new Scan(rx, patternOf(item, "old"), needed);
  for (const d of deliveries) scan.delivery(d, inTime(d, write), keptRecords(d.text, seed, boiler));
  const { hit, late } = scan;
  return {
    recalled: hit !== undefined,
    late: late !== undefined && hit === undefined,
    via: hit?.via ?? null,
    call: hit?.call ?? null,
    evidence: hit !== undefined ? [hit.evidence] : late !== undefined ? [late.evidence] : [],
    old_value_delivered: scan.oldSeen,
    delivered_chars: scan.characters,
    delivered_records: scan.records,
    unneeded_records: scan.unneeded,
    wrote: write !== null,
  };
}

export interface Stored {
  stored: boolean;
  by: string[];
  evidence: { by: string; fact: string; claim: string; line: string }[];
}

const part = (v: string | null | undefined): string => v ?? "";

/** The facts of the store after the plant that are not the seed's and match the item. */
export function stored(
  facts: readonly StoreFact[],
  seedClaims: ReadonlySet<string>,
  item: Item,
): Stored {
  const rx = patternOf(item);
  const found: Stored["evidence"] = [];
  for (const f of facts) {
    if (seedClaims.has(f.claim)) continue;
    const text = [part(f.claim), part(f.detail), part(f.question)].join(" ");
    const m = rx?.exec(text);
    if (m) {
      const by = part(f.from_session) !== "" ? "model step" : "agent";
      found.push({ by, fact: f.id, claim: f.claim, line: excerpt(text, m) });
    }
  }
  return {
    stored: found.length > 0,
    by: [...new Set(found.map((x) => x.by))].sort(),
    evidence: found,
  };
}

/** Problems with the items' patterns: any that matches a seed fact or a line of the product's boilerplate would credit what no earlier session put there. */
export function validatePatterns(
  items: Items,
  seed: readonly { claim: string; detail?: string }[],
  boilerplate: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const [name, item] of Object.entries(items)) {
    for (const key of ["pattern", "old"] as const) {
      const rx = patternOf(item, key);
      if (rx === undefined) continue;
      for (const s of seed) {
        if (rx.test(`${s.claim} ${s.detail ?? ""}`))
          problems.push(`${name} ${key} matches seed fact: ${s.claim.slice(0, 80)}`);
      }
      for (const l of boilerplate.filter((b) => b.trim() !== "")) {
        if (rx.test(l))
          problems.push(`${name} ${key} matches boilerplate: ${l.trim().slice(0, 80)}`);
      }
    }
  }
  return problems;
}
