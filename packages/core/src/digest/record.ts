/**
 * What a session left for a model to read, and what of a model's answer that record bears out.
 * The record is what the session's harness sent: each turn's request and the agent's final
 * answer, or, where no turn was sent, the session's note, which is the agent's last message.
 */
import type { Citation, SessionNote, Turn } from "../domain.ts";

/** One thing said in a session: what the person asked, and what the agent answered at the end of the turn. */
export interface Said {
  readonly request: string | null;
  readonly answer: string | null;
}

/** The most turns a session holds for the model step: a session that goes on past this has the rest dropped, not kept. */
export const MOST_TURNS_KEPT = 100;

/**
 * How long a turn that has been asked and not answered is taken to be running. After this it is
 * lost (the harness was killed, and no answer will come) and is dropped with the session's other
 * turns.
 */
export const RUNNING_TURN_MS = 12 * 3_600_000;

/**
 * The most characters of a session's text one chore carries: about twelve thousand tokens. A
 * session that left more is read in several chores, and none of it is dropped.
 */
const CHORE_CHARS = 48_000;

/**
 * A session whose agent said less than this left nothing worth a model's call: a call's
 * instructions alone are several times as long. A one-sentence answer that names a file is longer.
 */
const WORTH_READING_CHARS = 100;

function sizeOf(said: Said): number {
  return (said.request?.length ?? 0) + (said.answer?.length ?? 0);
}

/**
 * What a model reads of a session: its turns, or its note where no turn was kept and the note is
 * newer than the last reading. Nothing when the agent said too little to hold a fact.
 */
export function saidIn(
  turns: readonly Turn[],
  note: SessionNote | null,
  readBefore: Date | null,
): Said[] {
  const unread = note !== null && (readBefore === null || note.at > readBefore);
  const said: Said[] =
    turns.length > 0
      ? turns.map(({ request, answer }) => ({ request, answer }))
      : unread
        ? [{ request: null, answer: note.text }]
        : [];
  const answered = said.reduce((sum, each) => sum + (each.answer?.length ?? 0), 0);
  return answered < WORTH_READING_CHARS ? [] : said;
}

/** The record in pieces of at most `CHORE_CHARS`, in order, each turn whole in one piece. */
export function piecesOf(said: readonly Said[]): Said[][] {
  const pieces: Said[][] = [];
  let size = 0;
  for (const each of said) {
    const last = pieces.at(-1);
    if (last === undefined || size + sizeOf(each) > CHORE_CHARS) {
      pieces.push([each]);
      size = sizeOf(each);
    } else {
      last.push(each);
      size += sizeOf(each);
    }
  }
  return pieces;
}

/** Everything the record says, as one text: what a citation is held against. */
export function textOf(said: readonly Said[]): string {
  return said.flatMap((each) => [each.request ?? "", each.answer ?? ""]).join("\n");
}

/** Characters a path or an address is made of: a name found between two of these is part of a longer name. */
const NAME_CHAR = /[\w./-]/;

/** Whether the record names `name` itself, and not only a longer name that holds it. */
function names(record: string, name: string): boolean {
  for (let at = record.indexOf(name); at !== -1; at = record.indexOf(name, at + 1)) {
    const before = record[at - 1] ?? " ";
    const after = record[at + name.length] ?? " ";
    // A full stop after a name ends a sentence as often as it joins an extension.
    if (!NAME_CHAR.test(before) && (after === "." || !NAME_CHAR.test(after))) return true;
  }
  return false;
}

/** Whether the record gives a line number as a number of its own (`40`, `:40`, `L40`), not as digits inside a hash or a name. */
function hasLine(record: string, digits: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])L?${digits}(?![A-Za-z0-9_])`).test(record);
}

/**
 * A citation as far as the record bears it out, or null when the record does not name its source.
 * A model reads only the record, so a source it names that the record does not is made up. A file
 * keeps its lines and its commit only where the record holds those too. Only a file, a commit and
 * a web page can be held against a record: anything else a model cites is its own word.
 */
export function bornOut(record: string, citation: Citation): Citation | null {
  switch (citation.kind) {
    case "file": {
      if (!names(record, citation.path)) return null;
      const { lines, commit } = citation;
      const numbered = lines?.split("-").every((digits) => hasLine(record, digits)) === true;
      const pinned = commit !== undefined && record.toLowerCase().includes(commit);
      return {
        kind: "file",
        repo: citation.repo,
        path: citation.path,
        ...(numbered ? { lines } : {}),
        ...(pinned ? { commit } : {}),
      };
    }
    case "commit":
      return record.toLowerCase().includes(citation.commit) ? citation : null;
    case "web":
      return record.includes(citation.url) ? { kind: "web", url: citation.url } : null;
    default:
      return null;
  }
}
