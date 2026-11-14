/**
 * Text analysis shared by the write path (publish stores the identifiers of a fact) and search (the query's
 * identifiers and normalized form). Pure string functions; no clock, no store.
 */

/** NFKC, lowercase, whitespace collapsed to single spaces, trimmed. */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const MAX_IDENTIFIERS = 64;
const TOKEN_SEPARATORS = /[\s,;()[\]{}<>"'`]+/;
const TRAILING_PUNCTUATION = /[.,:;?!]+$/;
const VERSION = /^[vV]?\d+(\.\d+){1,3}([-+][0-9A-Za-z.-]+)?$/;
const HAS_DIGIT_AND_LETTER = /^(?=.*\d)(?=.*[A-Za-z])/;
const ALL_CAPS = /^[A-Z]{4,}$/;
const SEPARATOR_BETWEEN_LETTERS = /[A-Za-z](?:_|::|\/|\.)[A-Za-z]/;
const HTTP_STATUS = /^[1-5]\d\d$/;
/** "e.g", "i.e", "U.S" once the trailing dot is stripped: prose, though a dot sits between letters. */
const LETTER_ABBREVIATION = /^(?:[A-Za-z]\.)+[A-Za-z]$/;

/** `HTTP`, `status`, or a status line's protocol such as `HTTP/1.1`, lowercased. */
function introducesStatus(previous: string): boolean {
  return previous === "http" || previous === "status" || previous.startsWith("http/");
}

function isIdentifier(token: string, previous: string): boolean {
  if (LETTER_ABBREVIATION.test(token)) return false;
  return (
    HAS_DIGIT_AND_LETTER.test(token) ||
    VERSION.test(token) ||
    ALL_CAPS.test(token) ||
    SEPARATOR_BETWEEN_LETTERS.test(token) ||
    (HTTP_STATUS.test(token) && introducesStatus(previous))
  );
}

/** A path's line reference at its end: `:12` or `:12-40`. */
const LINE_REFERENCE = /:\d+(?:-\d+)?$/;

/**
 * The forms an identifier is found by: itself; a version without its leading `v`; a path without its
 * line reference; and each segment of a path that is an identifier by itself, so `src/retry.ts:41`
 * is also found as `src/retry.ts` and as `retry.ts`.
 */
function formsOf(token: string): string[] {
  const path = token.replace(LINE_REFERENCE, "");
  const parts = path.includes("/") ? path.split("/") : [];
  const derived = [path, ...parts].filter((form) => form !== token && isIdentifier(form, ""));
  return VERSION.test(token) && /^v/i.test(token) ? [token, token.slice(1)] : [token, ...derived];
}

/**
 * The identifier-like tokens of a text: lowercased, deduplicated, in first-seen order, at most 64. A token is
 * an identifier when it mixes letters and digits (`pg17`), is a version (`v2.3.1`), is four or more capitals
 * (`ECONNRESET`), joins letters with `_`, `::`, `/` or `.` (`user_id`, `fs.readFile`, `src/retry.ts`), or is an
 * HTTP status code introduced by `HTTP` or `status`. Each is emitted in every form `formsOf` gives it.
 */
export function extractIdentifiers(text: string): string[] {
  const found = new Set<string>();
  let previous = "";
  for (const raw of text.split(TOKEN_SEPARATORS)) {
    const token = raw.replace(TRAILING_PUNCTUATION, "");
    if (token === "") continue;
    if (isIdentifier(token, previous)) {
      for (const form of formsOf(token)) found.add(form.toLowerCase());
    }
    previous = token.toLowerCase();
  }
  return [...found].slice(0, MAX_IDENTIFIERS);
}
