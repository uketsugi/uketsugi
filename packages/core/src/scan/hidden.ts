/**
 * Text a reader cannot see and a model can read: what is deleted outright, and how a secret that
 * invisible characters were threaded through is still found.
 */
import ansiRegex from "ansi-regex";

/** A half-open range of UTF-16 offsets in a text. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** The tag-character spelling of ASCII text (the U+E0000 block). */
function tagSpelling(text: string): string {
  return [...text].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join("");
}

const BLACK_FLAG = "\u{1F3F4}";
/** The flags of England, Scotland and Wales are spelt with tag characters and are not hidden text. */
const TAG_FLAGS = ["gbeng", "gbsct", "gbwls"].map(
  (region) => `${BLACK_FLAG}${tagSpelling(region)}\u{E007F}`,
);
/** A tag flag matches first and is kept; any other tag character is hidden. */
const TAGS = new RegExp(`${TAG_FLAGS.join("|")}|[\\u{E0000}-\\u{E007F}]`, "gu");
/** Bidirectional embeddings, overrides and isolates: they reorder what a reader sees. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
/** C0 and C1 control characters; tab, line feed and carriage return among them are kept. */
const CONTROLS = /\p{Cc}/gu;
const KEPT_CONTROLS = new Set(["\t", "\n", "\r"]);

function spansOf(text: string, pattern: RegExp, keep: (match: string) => boolean): Span[] {
  return [...text.matchAll(pattern)]
    .filter((match) => keep(match[0]))
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

/**
 * The spans of hidden text: tag characters, bidirectional controls, control characters and the
 * escape sequences that rewrite what a terminal shows. Spans that touch are joined, so an escape
 * sequence and the control characters inside it go as one run.
 */
export function findHiddenText(text: string): Span[] {
  const all = () => true;
  const found = [
    ...spansOf(text, TAGS, (match) => !match.startsWith(BLACK_FLAG)),
    ...spansOf(text, BIDI_CONTROLS, all),
    ...spansOf(text, ansiRegex(), all),
    ...spansOf(text, CONTROLS, (match) => !KEPT_CONTROLS.has(match)),
  ].sort((a, b) => a.start - b.start);
  const joined: Span[] = [];
  for (const span of found) {
    const last = joined.at(-1);
    if (last !== undefined && span.start <= last.end) {
      joined[joined.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    } else {
      joined.push(span);
    }
  }
  return joined;
}

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/** A copy of a text without its invisible characters, with a way back to the original's offsets. */
export interface Shadow {
  readonly text: string;
  /** The span of the original that a span of the shadow covers, invisible characters inside it included. */
  original(span: Span): Span;
}

/**
 * The text without its default-ignorable code points (zero-width spaces and joiners, soft hyphens),
 * or null when it holds none. A rule that matches the shadow has found a secret someone split with
 * characters no reader sees.
 */
export function shadowOf(text: string): Shadow | null {
  let shadow = "";
  const origins: number[] = [];
  for (let at = 0; at < text.length;) {
    const point = String.fromCodePoint(text.codePointAt(at) ?? 0);
    if (!IGNORABLE.test(point)) {
      for (let unit = 0; unit < point.length; unit += 1) origins.push(at + unit);
      shadow += point;
    }
    at += point.length;
  }
  if (shadow.length === text.length) return null;
  return {
    text: shadow,
    original: (span) => ({
      start: origins[span.start] ?? 0,
      end: (origins[span.end - 1] ?? -1) + 1,
    }),
  };
}
