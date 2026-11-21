/**
 * The headline, the table and the comparison, from `result.json` (format 2): the run's settings;
 * `cells` (one per needed cell and control draw); `cases` (one per item run: product, configuration,
 * item, repeat, kind, stored, tokens, minutes, error); and `recall` per "product/configuration":
 * {hits, cells, percent, low, high, left_out, control, delivered_chars}.
 *
 * The one number is recall: the share of expected repeated research recalled from memory (needed
 * cells where memory delivered the item before the agent's first write, from what an earlier session
 * put there, over all needed cells). It is the first line of the output and of `--compare`.
 */
import type { Items } from "./items.ts";
import type { Recalled, Stored } from "./measure.ts";
import { difference, interval, type PerItem } from "./stats.ts";

export const FORMAT = 2;
/** When two configurations' delivered characters per session differ by more than this, the output says so. */
const BIG_DELIVERY = 3;

export interface Cell {
  product: string;
  config: string;
  item: string;
  kind: "treatment" | "control";
  repeat: number;
  task: string;
  session: string | null;
  recalled: Recalled;
  used: { first: boolean; final: boolean } | null;
  error?: string;
}

export interface CaseRecord {
  product: string;
  config: string;
  item: string;
  kind: "treatment" | "control";
  repeat: number;
  model?: string;
  sessions?: number;
  setup?: unknown;
  stored?: Stored | null;
  minutes?: number;
  tokens?: number;
  /** Dollars at list price, from the same request log as `tokens`. */
  usd?: number;
  model_step_usd?: number;
  /** Stops that killed the server (it had not gone in the product's time), and starts that recovered a store; absent where the case did not count them. */
  killed_stops?: number;
  recovered_starts?: number;
  error?: string;
  note?: string;
  /** Search results of the case that were marked `no_model`; absent where the case was not scored from its transcripts. */
  no_model?: number;
  /** The needed cells of the item, which a treatment case that errors leaves unmeasured: they count as misses. */
  expected?: number;
}

export interface Summary {
  hits: number;
  cells: number;
  percent: number | null;
  low: number | null;
  high: number | null;
  left_out: string[];
  no_control: string[];
  per_item: Record<string, [number, number]>;
  control: Record<string, [number, number]>;
  delivered_chars: number | null;
  unneeded_records: number | null;
  errored: number;
  /** Items of errored treatment cases whose needed cells the record does not say, so they could not be counted as misses. */
  unmeasured: string[];
  /** Search results marked `no_model` over the run: any makes it void, since the server matched words only. */
  no_model: number;
  /** Cases that were scored but never recorded whether their results were marked. */
  unchecked: number;
}

export interface Totals {
  tokens: number;
  usd: number;
  minutes: number;
  model_step_usd: number;
  sessions: number;
  errors: number;
  errored_attempts: number;
  killed_stops: number;
  recovered_starts: number;
}

export interface Result {
  format: number;
  product: string;
  configs: string[];
  model: string;
  mode: string;
  shape: string;
  gap: number;
  repeat: number;
  cells: Cell[];
  cases: CaseRecord[];
  superseded?: CaseRecord[];
  recall: Record<string, Summary>;
  totals?: Record<string, Totals>;
  [other: string]: unknown;
}

const key = (r: { product: string; config: string }): string => `${r.product}/${r.config}`;
const treatment = (result: Result, k: string): Cell[] =>
  result.cells.filter((c) => key(c) === k && c.kind === "treatment");

/** {item: [draws that recalled, draws]}: the control must score 0. */
function controls(result: Result, k: string): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const c of result.cells) {
    if (key(c) !== k || c.kind !== "control" || c.error !== undefined) continue;
    const [hits, n] = out[c.item] ?? [0, 0];
    out[c.item] = [hits + Number(c.recalled.recalled), n + 1];
  }
  return out;
}

function perItem(
  cells: readonly Cell[],
  skip: readonly string[] = [],
): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const c of cells) {
    if (skip.includes(c.item)) continue;
    const [hits, n] = out[c.item] ?? [0, 0];
    out[c.item] = [hits + Number(c.recalled.recalled), n + 1];
  }
  return out;
}

const sum = (values: Iterable<number>): number => [...values].reduce((a, b) => a + b, 0);
const mean = (values: readonly number[]): number | null =>
  values.length > 0 ? sum(values) / values.length : null;
const pct = (x: number): number => Math.round(100 * x);

/** The needed cells of the treatment cases that errored, as misses against their items; and the items of those whose cells were never counted. */
function errorsAsMisses(
  cases: readonly CaseRecord[],
  skip: readonly string[],
): { misses: Record<string, [number, number]>; unmeasured: string[] } {
  const misses: Record<string, [number, number]> = {};
  const unmeasured: string[] = [];
  for (const c of cases.filter((x) => x.kind === "treatment" && x.error !== undefined)) {
    if (skip.includes(c.item)) continue;
    if (c.expected === undefined) unmeasured.push(c.item);
    else misses[c.item] = [0, (misses[c.item]?.[1] ?? 0) + c.expected];
  }
  return { misses, unmeasured: [...new Set(unmeasured)].sort() };
}

/** Item by item, the hits and cells of `a` and of `b` added. */
function added(
  a: Record<string, [number, number]>,
  b: Record<string, [number, number]>,
): Record<string, [number, number]> {
  const out = { ...a };
  for (const [item, [hits, n]] of Object.entries(b)) {
    const [h0, n0] = out[item] ?? [0, 0];
    out[item] = [h0 + hits, n0 + n];
  }
  return out;
}

/** One product and configuration's recall, over the items whose control was clean (none of its draws recalled). A treatment case that errored counts as misses against its item: the item set never depends on what errored. */
function summaryOf(result: Result, k: string): Summary {
  const control = controls(result, k);
  const leftOut = Object.keys(control)
    .filter((i) => (control[i]?.[0] ?? 0) > 0)
    .sort();
  const own = treatment(result, k);
  const ownCases = result.cases.filter((c) => key(c) === k);
  const ran = ownCases.filter((c) => c.kind === "treatment").map((c) => c.item);
  const noControl = [...new Set(ran)].filter((i) => !(i in control)).sort();
  const { misses, unmeasured } = errorsAsMisses(ownCases, leftOut);
  const items = added(perItem(own, leftOut), misses);
  const hits = sum(Object.values(items).map((v) => v[0]));
  const n = sum(Object.values(items).map((v) => v[1]));
  const bounds = interval(items);
  const mine = own.map((c) => c.recalled);
  const chars = mean(mine.map((m) => m.delivered_chars));
  const unneeded = mean(mine.map((m) => m.unneeded_records));
  return {
    hits,
    cells: n,
    percent: n > 0 ? pct(hits / n) : null,
    low: bounds ? pct(bounds[0]) : null,
    high: bounds ? pct(bounds[1]) : null,
    left_out: leftOut,
    no_control: noControl,
    per_item: items,
    control,
    delivered_chars: chars === null ? null : Math.round(chars),
    unneeded_records: unneeded === null ? null : Math.round(unneeded * 10) / 10,
    errored: ownCases.filter((c) => c.error !== undefined).length,
    unmeasured,
    no_model: sum(ownCases.map((c) => c.no_model ?? 0)),
    unchecked: ownCases.filter((c) => c.error === undefined && c.no_model === undefined).length,
  };
}

/** Fills `recall`: per product and configuration. */
export function summarize(result: Result): Result {
  const keys = [...new Set(result.cases.map(key))];
  result.recall = Object.fromEntries(keys.map((k) => [k, summaryOf(result, k)]));
  return result;
}

/** Whether a run is to end with a failing exit: a case errored, or the run is void. */
export const failed = (result: Result): boolean =>
  result.cases.some((c) => c.error !== undefined) ||
  Object.values(result.recall).some((v) => v.no_model > 0);

const voidWords = (v: Summary): string =>
  `${v.no_model} search results of this run were marked no_model: its server matched words only, so it is not a run of the product as shipped`;

/** What a run says of the stops that killed its server and the starts that recovered a store: nothing when there were none. */
const uncleanWords = (t: Totals | undefined): string =>
  t === undefined || t.killed_stops + t.recovered_starts === 0
    ? ""
    : `; ${t.killed_stops} stops killed the server and ${t.recovered_starts} starts recovered a store (it was cut off between sessions)`;

/** The first line of the output: recall, per product and configuration, then what to read it with. */
export function headline(result: Result): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(result.recall)) {
    let line =
      `recall ${k} (${result.model}): ` +
      (v.cells > 0
        ? `${v.hits}/${v.cells} = ${v.percent}% (${v.low} to ${v.high}%, 90% interval over items)`
        : "no cell measured");
    if (v.left_out.length > 0) line += `; left out, control above zero: ${v.left_out.join(", ")}`;
    if (v.no_control.length > 0) line += `; no control run: ${v.no_control.join(", ")}`;
    if (v.errored > 0)
      line += `; ${v.errored} cases errored (a treatment's cells count as misses; an item whose control errored has none)`;
    if (v.unmeasured.length > 0)
      line += `; errored cases of ${v.unmeasured.join(", ")} could not be counted (their record has no needed cells)`;
    if (v.unchecked > 0) line += `; ${v.unchecked} cases never recorded whether the model was used`;
    line += uncleanWords(result.totals?.[k]);
    lines.push(v.no_model > 0 ? `VOID: ${voidWords(v)}\n${line}` : line);
  }
  const chars = Object.entries(result.recall).filter(([, v]) => v.delivered_chars);
  for (const [a, va] of chars) {
    for (const [b, vb] of chars) {
      const [x, y] = [va.delivered_chars as number, vb.delivered_chars as number];
      if (a < b && x > BIG_DELIVERY * y) {
        lines.push(
          `note: ${a} delivers ${x.toLocaleString("en-US")} characters a session, ${(x / y).toFixed(1)} times ${b}'s ${y.toLocaleString("en-US")}: its recall is not for the same delivery`,
        );
      }
    }
  }
  lines.push(
    "a clean control is evidence that the patterns do not match what the product delivers without the item, not proof; it probes only each item's first needing task",
  );
  return lines.join("\n");
}

function storedOf(result: Result, k: string, item: string): Stored[] {
  return result.cases
    .filter((c) => key(c) === k && c.kind === "treatment" && c.item === item && c.stored)
    .map((c) => c.stored as Stored);
}

export function table(result: Result, items: Items): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(result.recall)) {
    lines.push(
      `\n${k}`,
      "| item | recalled (cells) | by | stored | used | old value delivered | control | chars a session | unneeded records |",
      "|---|---|---|---|---|---|---|---|---|",
    );
    for (const item of Object.keys(items)) {
      const mine = treatment(result, k).filter((c) => c.item === item);
      if (mine.length === 0) continue;
      const ok = mine.filter((c) => c.recalled.recalled).length;
      const via =
        [...new Set(mine.map((c) => c.recalled.via).filter((x) => x !== null))].sort().join(", ") ||
        "-";
      const stored = storedOf(result, k, item);
      const used = mine.filter((c) => c.used).map((c) => (c.used as { first: boolean }).first);
      const ctl = v.control[item];
      const avg = (f: (r: Recalled) => number): number =>
        sum(mine.map((c) => f(c.recalled))) / mine.length;
      lines.push(
        `| ${item}${v.left_out.includes(item) ? " (left out)" : ""} | ${ok}/${mine.length} | ${via} | ${stored.filter((s) => s.stored).length}/${stored.length} | ` +
          `${used.filter(Boolean).length}/${used.length} | ${mine.filter((c) => c.recalled.old_value_delivered).length} | ${ctl ? `${ctl[0]}/${ctl[1]}` : "-"} | ` +
          `${Math.round(avg((r) => r.delivered_chars)).toLocaleString("en-US")} | ${(Math.round(avg((r) => r.unneeded_records) * 10) / 10).toString()} |`,
      );
    }
  }
  return lines.join("\n");
}

/** Tokens, minutes and spend of every case, including the attempts a later run replaced (`superseded`: they were spent). */
export function totals(result: Result): Record<string, Totals> {
  const out: Record<string, Totals> = {};
  for (const r of [...result.cases, ...(result.superseded ?? [])]) {
    const t = (out[key(r)] ??= {
      tokens: 0,
      usd: 0,
      minutes: 0,
      model_step_usd: 0,
      sessions: 0,
      errors: 0,
      errored_attempts: 0,
      killed_stops: 0,
      recovered_starts: 0,
    });
    t.tokens += r.tokens ?? 0;
    t.usd += r.usd ?? 0;
    t.minutes += r.minutes ?? 0;
    t.model_step_usd += r.model_step_usd ?? 0;
    t.sessions += r.sessions ?? 0;
    t.errors += Number(r.error !== undefined && result.cases.includes(r));
    t.errored_attempts += Number(r.error !== undefined);
    t.killed_stops += r.killed_stops ?? 0;
    t.recovered_starts += r.recovered_starts ?? 0;
  }
  return out;
}

/** One line for each cell: what showed it recalled or not. */
export function evidence(result: Result): string {
  return result.cells
    .map((c) => {
      const r = c.recalled;
      return (
        `${key(c)} ${c.kind} ${c.item} at ${c.task} (repeat ${c.repeat}): recalled=${r.recalled}` +
        (r.via ? ` via ${r.via}` : "") +
        (r.late ? " LATE" : "") +
        (r.evidence[0] ? `: ${r.evidence[0]}` : "")
      );
    })
    .join("\n");
}

/** The items a run covers, whether or not its control was clean. */
const itemsOf = (v: Summary): string[] => [...Object.keys(v.per_item), ...v.left_out].sort();

/** Why two runs of a configuration cannot be set side by side, or undefined: one is void or never recorded whether it was, an errored case's cells are not recorded, or they cover different items. */
function unsound(k: string, o: Summary, n: Summary): string | undefined {
  const sides = [
    ["earlier", o],
    ["later", n],
  ] as const;
  for (const [side, v] of sides)
    if (v.no_model > 0) return `${k}: refused, the ${side} run is void (${voidWords(v)})`;
  for (const [side, v] of sides)
    if (v.unmeasured.length > 0)
      return `${k}: refused, the ${side} run has errored cases whose needed cells are not recorded, so its item set is not fixed: rescore it from its evidence first`;
  const [mine, theirs] = [itemsOf(o), itemsOf(n)];
  if (mine.join() !== theirs.join())
    return `${k}: refused, the runs cover different items (earlier: ${mine.join(", ")}; later: ${theirs.join(", ")}): a headline over one set is not set beside one over another`;
  for (const [side, v] of sides)
    if (v.unchecked > 0)
      return `${k}: refused, the ${side} run never recorded whether its results were marked no_model: rescore it from its evidence first`;
  return undefined;
}

/** `now` against `old`, paired by item over the items that were clean in both, with the interval; "not shown" where it spans zero. The recall change leads. */
export function compare(old: Result, now: Result): string {
  const lines: string[] = [];
  for (const [k, n] of Object.entries(now.recall)) {
    const o = old.recall[k];
    if (o === undefined) continue;
    const refusal = unsound(k, o, n);
    if (refusal !== undefined) {
      lines.push(refusal);
      continue;
    }
    const skip = new Set([...o.left_out, ...n.left_out]);
    const keep = (v: Record<string, [number, number]>): PerItem =>
      Object.fromEntries(Object.entries(v).filter(([i]) => !skip.has(i)));
    const [a, b] = [keep(o.per_item), keep(n.per_item)];
    const d = difference(a, b);
    if (d === undefined) {
      lines.push(`${k}: no item in both`);
      continue;
    }
    const points = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}`;
    const verdict = d.shown
      ? `${points(d.change)} points (${points(d.low)} to ${points(d.high)}%)`
      : `not shown: ${points(d.change)} points, the interval ${points(d.low)} to ${points(d.high)}% spans zero`;
    const total = (v: PerItem, at: 0 | 1): number => sum(Object.values(v).map((x) => x[at]));
    lines.push(
      `recall ${k}: ${total(a, 0)}/${total(a, 1)} -> ${total(b, 0)}/${total(b, 1)} on ${d.items.length} items clean in both` +
        `${skip.size > 0 ? ` (left out: ${[...skip].sort().join(", ")})` : ""}: ${verdict}`,
    );
    const [oc, nc] = [o.delivered_chars, n.delivered_chars];
    if (oc && nc && Math.max(oc, nc) > BIG_DELIVERY * Math.min(oc, nc)) {
      lines.push(
        `note: delivered characters a session differ by more than ${BIG_DELIVERY} times (${oc.toLocaleString("en-US")} -> ${nc.toLocaleString("en-US")}): the recall is not for the same delivery`,
      );
    }
  }
  const [t0, t1] = [totals(old), totals(now)];
  for (const [k, t] of Object.entries(t1)) {
    const o = t0[k];
    if (o)
      lines.push(
        `${k} tokens: ${o.tokens.toLocaleString("en-US")} -> ${t.tokens.toLocaleString("en-US")}; dollars: ${o.usd.toFixed(2)} -> ${t.usd.toFixed(2)}; minutes: ${o.minutes.toFixed(0)} -> ${t.minutes.toFixed(0)}`,
      );
  }
  return lines.join("\n") || "nothing in both";
}
