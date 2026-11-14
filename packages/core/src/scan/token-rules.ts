/**
 * The provider-token rules of gitleaks, vendored as data in `token-rules.json` and run with re2js,
 * which takes their Go (RE2) patterns as written and matches in time linear in the text. A rule is
 * tried only when the text holds one of its keywords; a match counts unless its secret is below
 * the rule's entropy floor or an allowlist excuses it. A secret is taken to the end of the run of
 * token characters it ends in, so a token longer than its rule expects leaves no tail.
 */
import { RE2JS } from "re2js";
import type { Span } from "./hidden.ts";
import data from "./token-rules.json" with { type: "json" };

interface Allowlist {
  /** `AND` needs every criterion present to hold; otherwise any one excuses the match. */
  readonly condition?: string;
  /** What the regexes test: the secret (the default), the whole `match` or the `line` holding it. */
  readonly regexTarget?: string;
  readonly regexes?: readonly string[];
  /** Words that excuse a match when its secret holds one, ignoring case. */
  readonly stopwords?: readonly string[];
}

interface TokenRule {
  readonly id: string;
  readonly regex: string;
  readonly keywords: readonly string[];
  /** The secret must exceed this entropy, in bits per character. */
  readonly entropy?: number;
  /** The capture group holding the secret; the first group that matched when absent. */
  readonly secretGroup?: number;
  readonly allowlists?: readonly Allowlist[];
}

/** A span of a text that a rule says is a secret or personal data. */
export interface Finding extends Span {
  readonly rule: string;
}

const RULES: readonly TokenRule[] = data.rules;
const GLOBAL_ALLOWLIST: Allowlist = data.allowlist;
const KEYWORDS = RULES.map((rule) => rule.keywords.map((keyword) => keyword.toLowerCase()));

const compiled = new Map<string, RE2JS>();

/** A pattern in RE2 syntax, compiled once. */
export function re2(regex: string): RE2JS {
  let pattern = compiled.get(regex);
  if (pattern === undefined) {
    pattern = RE2JS.compile(regex);
    compiled.set(regex, pattern);
  }
  return pattern;
}

/** Shannon entropy of a text, in bits per character: how gitleaks tells a key from a word. */
export function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  let length = 0;
  for (const char of text) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
    length += 1;
  }
  let bits = 0;
  for (const count of counts.values()) bits -= (count / length) * Math.log2(count / length);
  return bits;
}

interface Candidate {
  readonly secret: string;
  readonly match: string;
  readonly line: string;
}

function isAllowed(allowlist: Allowlist, candidate: Candidate): boolean {
  const target =
    allowlist.regexTarget === "line"
      ? candidate.line
      : allowlist.regexTarget === "match"
        ? candidate.match
        : candidate.secret;
  const secret = candidate.secret.toLowerCase();
  const checks: boolean[] = [];
  if (allowlist.regexes !== undefined) {
    checks.push(allowlist.regexes.some((regex) => re2(regex).matcher(target).find()));
  }
  if (allowlist.stopwords !== undefined) {
    checks.push(allowlist.stopwords.some((word) => secret.includes(word.toLowerCase())));
  }
  return allowlist.condition === "AND"
    ? checks.length > 0 && checks.every(Boolean)
    : checks.some(Boolean);
}

/** The line of `text` that holds the span starting at `start` and ending at `end`. */
function lineOf(text: string, start: number, end: number): string {
  const from = start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
  const to = text.indexOf("\n", end);
  return text.slice(from, to < 0 ? text.length : to);
}

/** The group that holds the secret of the current match: the rule's own, else the first that matched, else the whole match. */
function secretGroup(rule: TokenRule, matcher: ReturnType<RE2JS["matcher"]>): number {
  if (rule.secretGroup !== undefined) return rule.secretGroup;
  for (let group = 1; group <= matcher.groupCount(); group += 1) {
    if (matcher.group(group)) return group;
  }
  return 0;
}

/** Whether a character is one a token is written in: a letter, a digit, `_` or `-`. */
function inToken(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z0-9_-]$/.test(char);
}

/**
 * Where the secret that a match ends in really ends. A provider's rule that counts characters
 * stops at its count, and providers lengthen their tokens: where the text goes on in a token's
 * characters, they are the token's tail, and the whole run is the secret.
 */
function endOfRun(text: string, end: number): number {
  if (!inToken(text[end - 1])) return end;
  let at = end;
  while (inToken(text[at])) at += 1;
  return at;
}

function findingsOf(rule: TokenRule, text: string): Finding[] {
  const found: Finding[] = [];
  const matcher = re2(rule.regex).matcher(text);
  while (matcher.find()) {
    const group = secretGroup(rule, matcher);
    const secret = matcher.group(group) ?? "";
    if (secret === "") continue;
    if (rule.entropy !== undefined && shannonEntropy(secret) <= rule.entropy) continue;
    const whole = { start: matcher.start(), end: matcher.end() };
    const candidate = {
      secret,
      match: text.slice(whole.start, whole.end),
      line: lineOf(text, whole.start, whole.end),
    };
    const excused =
      isAllowed(GLOBAL_ALLOWLIST, candidate) ||
      (rule.allowlists ?? []).some((allowlist) => isAllowed(allowlist, candidate));
    if (!excused) {
      const end = endOfRun(text, matcher.end(group));
      found.push({ rule: rule.id, start: matcher.start(group), end });
    }
  }
  return found;
}

/** The secrets the vendored rules find in a text: each with the span of the secret alone. */
export function findTokens(text: string): Finding[] {
  const lowered = text.toLowerCase();
  return RULES.flatMap((rule, index) => {
    const keywords = KEYWORDS[index] ?? [];
    const tried = keywords.length === 0 || keywords.some((keyword) => lowered.includes(keyword));
    return tried ? findingsOf(rule, text) : [];
  });
}
