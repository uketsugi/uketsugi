/**
 * The scanner: takes secrets and personal data out of a text before it is stored, indexed or
 * embedded. It is the first step of every write. It replaces each match with a placeholder naming
 * the rule, deletes text no reader can see, and says which rules replaced something, never what
 * they matched. It is pattern-based, so a secret in a novel format passes.
 */
import { findHiddenText, shadowOf, type Span } from "./hidden.ts";
import { RULES, VENDORED_AS } from "./rules.ts";
import { findTokens, type Finding } from "./token-rules.ts";

/** The rule id a result names when hidden text was deleted. */
const HIDDEN_TEXT = "hidden-text";

export interface ScanOptions {
  /** Leave addresses and phone numbers as written: the text is a path or a URL, not prose. */
  readonly secretsOnly?: boolean;
}

/** A text as it may be stored, and the rules that changed it, once each in the order they first matched. */
export interface Scanned {
  readonly text: string;
  readonly rules: readonly string[];
}

/** What a placeholder looks like, so nothing downstream mistakes it for the author's words. */
function placeholder(rule: string): string {
  return `[redacted:${rule}]`;
}

/** A finding and whether it is personal data: where two start together, the secret is the one replaced. */
type Ranked = Finding & { readonly personal: boolean };

function findingsIn(text: string, options: ScanOptions): Ranked[] {
  const ours = RULES.filter((rule) => !(options.secretsOnly === true && rule.personal === true));
  return [
    ...ours.flatMap((rule) =>
      rule.find(text).map((span) => ({ ...span, rule: rule.id, personal: rule.personal === true })),
    ),
    ...findTokens(text).map((found) => ({
      ...found,
      rule: VENDORED_AS[found.rule] ?? found.rule,
      personal: false,
    })),
  ];
}

/**
 * The order findings are applied in: by where they start; where two start together, a secret
 * before personal data, the longer before the shorter, a provider's rule before a generic one.
 */
function byPlace(a: Ranked, b: Ranked): number {
  const generic = (found: Ranked): number => Number(found.rule.startsWith("generic-"));
  return (
    a.start - b.start ||
    Number(a.personal) - Number(b.personal) ||
    b.end - a.end ||
    generic(a) - generic(b)
  );
}

function without(text: string, spans: readonly Span[]): string {
  let kept = "";
  let cursor = 0;
  for (const span of spans) {
    kept += text.slice(cursor, span.start);
    cursor = span.end;
  }
  return kept + text.slice(cursor);
}

/** A stretch of a text that findings cover between them: it is replaced as one, by a placeholder per rule. */
interface Run {
  readonly start: number;
  end: number;
  readonly rules: string[];
}

/**
 * The stretches to replace, from findings in the order of their places. A finding wholly inside a
 * stretch is covered by it. One that starts inside and reaches past its end makes the stretch
 * longer and is named with it: nothing a rule matched is left behind a placeholder.
 */
function runsOf(findings: readonly Finding[]): Run[] {
  const runs: Run[] = [];
  for (const found of findings) {
    const last = runs.at(-1);
    if (last === undefined || found.start >= last.end) {
      runs.push({ start: found.start, end: found.end, rules: [found.rule] });
    } else if (found.end > last.end) {
      last.end = found.end;
      if (!last.rules.includes(found.rule)) last.rules.push(found.rule);
    }
  }
  return runs;
}

/** Scans one text. The same text scanned twice comes out the same. */
export function scanText(text: string, options: ScanOptions = {}): Scanned {
  const hidden = findHiddenText(text);
  const visible = hidden.length === 0 ? text : without(text, hidden);
  const shadow = shadowOf(visible);
  const findings = [
    ...findingsIn(visible, options),
    ...(shadow === null
      ? []
      : findingsIn(shadow.text, options).map((found) => ({ ...found, ...shadow.original(found) }))),
  ].sort(byPlace);

  const rules = new Set<string>();
  let stored = "";
  let cursor = 0;
  for (const run of runsOf(findings)) {
    stored += visible.slice(cursor, run.start) + run.rules.map(placeholder).join("");
    cursor = run.end;
    for (const rule of run.rules) rules.add(rule);
  }
  if (hidden.length > 0) rules.add(HIDDEN_TEXT);
  return { text: stored + visible.slice(cursor), rules: [...rules] };
}

/** One thing the scanner changed in a write: the field and the rule, never the text. */
export interface Replacement {
  readonly field: string;
  readonly rule: string;
}

/**
 * Scans the named texts of one write: the first step of every write, and the one place a text is
 * made storable. Returns each under the same name, scanned and trimmed, and what was replaced in
 * which. A text that is absent, or blank once scanned, is null.
 */
export function scanFields<K extends string>(
  fields: Readonly<Record<K, string | null | undefined>>,
  options: ScanOptions = {},
): { fields: Record<K, string | null>; replaced: Replacement[] } {
  const scanned = {} as Record<K, string | null>;
  const replaced: Replacement[] = [];
  for (const field of Object.keys(fields) as K[]) {
    const text = fields[field];
    if (text === null || text === undefined) {
      scanned[field] = null;
      continue;
    }
    const result = scanText(text, options);
    scanned[field] = result.text.trim() || null;
    replaced.push(...result.rules.map((rule) => ({ field, rule })));
  }
  return { fields: scanned, replaced };
}
