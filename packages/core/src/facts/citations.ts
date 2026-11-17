/**
 * Citations: from what an agent sends to the typed record, its class and its lookup keys.
 * The class is the agent's word in every tier: the server opens no source and fetches no URL. It
 * only refuses to call checkable what cannot be open to an audience: a path on one machine, an
 * address that is not public.
 */
import type { Citation as CitationView } from "@uketsugi/contracts";
import type { Citation, ClassedCitation, ProjectRef } from "../domain.ts";
import { invalidInput } from "../failure.ts";
import { isRecord } from "../validate.ts";

const COMMIT = /^(?:commit\s+)?([0-9a-f]{7,40})$/i;
/** The shape of an id, in a syntax every regular-expression engine here reads; match it ignoring case. */
export const UUID_SHAPE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_SHAPE}$`, "i");

/** Whether a text has the shape of an id. One that has not is never sent to a store as one. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
/** `path`, then lines as `:12`, `:12-40`, `#L12` or `#L12-L40`, then `@commit`; lines and commit are optional. */
const FILE = /^([^\s:#]+?)(?:(?::|#L)(\d+)(?:-L?(\d+))?)?(?:@([0-9a-f]{7,40}))?$/i;
const WEB = /^https?:\/\//i;
/** A path that names a place on one machine: absolute, under a home directory, on a drive, or climbing out. */
const MACHINE_PATH = /^(?:\/|~|[A-Za-z]:[\\/])|(?:^|\/)\.\.(?:\/|$)/;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The file a string names, if it has the shape of a path inside a repository. */
function fileOf(value: string, repo: string): Citation | null {
  const file = FILE.exec(value);
  const path = file?.[1] ?? "";
  if (file === null || !/[./]/.test(path) || MACHINE_PATH.test(path)) return null;
  const [, , from, to, commit] = file;
  return {
    kind: "file",
    repo,
    path,
    ...(from === undefined ? {} : { lines: to === undefined ? from : `${from}-${to}` }),
    ...(commit === undefined ? {} : { commit: commit.toLowerCase() }),
  };
}

/** A string that names a source by itself: a URL, a fact, a commit or a file. Anything else is prose. */
function referenceOf(value: string, project: ProjectRef): Citation | null {
  if (WEB.test(value)) return { kind: "web", url: value };
  if (isUuid(value)) return { kind: "fact", fact: value.toLowerCase() };
  // Only a repository has commits and files anyone else can open.
  if (project.kind !== "repository") return null;
  const commit = COMMIT.exec(value)?.[1];
  if (commit !== undefined)
    return { kind: "commit", repo: project.key, commit: commit.toLowerCase() };
  return fileOf(value, project.key);
}

/** The kind an object without one most plainly is, by the field only that kind has. */
function kindOf(raw: Record<string, unknown>): unknown {
  if (raw.kind !== undefined) return raw.kind;
  const fields: [string, Citation["kind"]][] = [
    ["url", "web"],
    ["path", "file"],
    ["commit", "commit"],
    ["fact", "fact"],
    ["who", "person"],
    ["title", "document"],
  ];
  return fields.find(([field]) => text(raw[field]) !== undefined)?.[1];
}

/** The failure for an object citation that lacks a field its kind needs. */
function missing(at: string, kind: unknown, field: string) {
  return invalidInput(
    `${at} is a ${String(kind)} citation without \`${field}\`.`,
    `Add \`${field}\` to that citation, or send it as one string such as \`src/app.ts:10-20@<commit>\`.`,
  );
}

/** A file citation from its object form: lines as `12`, `12-40` or `L12-L40`. */
function fileFrom(raw: Record<string, unknown>, repo: string, path: string): Citation {
  const lines = text(raw.lines)?.replace(/^#?L/i, "").replace(/-L/i, "-");
  const commit = text(raw.commit)?.toLowerCase();
  return {
    kind: "file",
    repo,
    path,
    ...(lines !== undefined && /^\d+(-\d+)?$/.test(lines) ? { lines } : {}),
    ...(commit === undefined ? {} : { commit }),
  };
}

function fromObject(raw: Record<string, unknown>, project: ProjectRef, at: string): Citation {
  const kind = kindOf(raw);
  const repo = text(raw.repo) ?? project.key;
  const need = (field: string): string => {
    const value = text(raw[field]);
    if (value === undefined) throw missing(at, kind, field);
    return value;
  };
  const optional = (field: string): Record<string, string> => {
    const value = text(raw[field]);
    return value === undefined ? {} : { [field]: value };
  };
  switch (kind) {
    case "file":
      return fileFrom(raw, repo, need("path"));
    case "commit":
      return { kind, repo, commit: need("commit").toLowerCase() };
    case "pull_request":
    case "issue": {
      const number = Number(raw.number);
      if (!Number.isInteger(number) || number <= 0) throw missing(at, kind, "number");
      return { kind, repo, number };
    }
    case "web":
      return { kind, url: need("url"), ...optional("quote") };
    case "fact":
      return { kind, fact: need("fact").toLowerCase() };
    case "document":
      return { kind, title: need("title"), ...optional("url") };
    case "person":
      return { kind, who: need("who"), ...optional("at") };
    default:
      // An unknown kind counts as testimony: what it says is kept as a local observation.
      return {
        kind: "observation",
        text: text(raw.text) ?? JSON.stringify(raw),
        ...optional("at"),
      };
  }
}

/** The typed citation for one entry of a call's `citations`: a string or an object. */
export function parseCitation(raw: unknown, project: ProjectRef, index: number): Citation {
  const at = `citations[${index}]`;
  const value = text(raw);
  if (value !== undefined) {
    return referenceOf(value, project) ?? { kind: "observation", text: value };
  }
  if (isRecord(raw)) return fromObject(raw, project, at);
  throw invalidInput(
    `${at} is neither text nor an object.`,
    "Send each citation as a string: `path:lines`, `path:lines@commit`, a commit or a URL.",
  );
}

/**
 * One entry as the citations it holds. Agents send a list as one string in two ways: a JSON array
 * in text (`["a.ts:4","b.ts:9"]`), and references joined by commas or semicolons. A joined string
 * is split only when every part names a source by itself, so a sentence with commas stays whole.
 */
function entriesOf(raw: unknown, project: ProjectRef): unknown[] {
  if (typeof raw !== "string") return [raw];
  const value = raw.trim();
  if (value.startsWith("[")) {
    try {
      const listed: unknown = JSON.parse(value);
      if (Array.isArray(listed)) return listed;
    } catch {
      // Not JSON: it is read as written.
    }
  }
  const parts = value.split(/\s*[;,]\s*/).filter((part) => part !== "");
  const joined = parts.length > 1 && parts.every((part) => referenceOf(part, project) !== null);
  return joined ? parts : [raw];
}

/** The typed citations of a call, each source once, in the order sent. A call must name at least one. */
export function parseCitations(raw: readonly unknown[], project: ProjectRef): Citation[] {
  const entries = raw.flatMap((entry) => entriesOf(entry, project));
  const parsed = entries.map((entry, index) => parseCitation(entry, project, index));
  const seen = new Set<string>();
  const distinct = parsed.filter((citation) => {
    const key = JSON.stringify(citation);
    return seen.has(key) ? false : Boolean(seen.add(key));
  });
  if (distinct.length === 0) {
    throw invalidInput(
      "citations is empty.",
      "Say where the claim comes from: a file and its lines (`src/app.ts:10-20`), a commit or a URL.",
    );
  }
  return distinct;
}

/** Why a URL is not a public web page, or null when nothing says it is not. */
function notPublic(url: string): string | null {
  if (!URL.canParse(url)) return "not a URL";
  const host = new URL(url).hostname.toLowerCase();
  const isAddress = /^\[.*\]$|^\d+(\.\d+){3}$/.test(host);
  const isInternal = !host.includes(".") || /\.(?:local|localhost|internal|lan)$/.test(host);
  return isAddress || isInternal ? "not a public address" : null;
}

/**
 * A citation's class. A repository item or a public web page is checkable: anyone in the audience
 * can open it. A cited fact passes its own class on, which `factIsCheckable` answers. Everything
 * else is testimony, with the reason.
 */
export function classify(
  citation: Citation,
  factIsCheckable: (factId: string) => boolean,
): ClassedCitation {
  const testimony = (reason: string): ClassedCitation => ({ citation, class: "testimony", reason });
  switch (citation.kind) {
    case "file":
      return MACHINE_PATH.test(citation.path)
        ? testimony("a path on one machine, not in the repository")
        : { citation, class: "checkable" };
    case "commit":
    case "pull_request":
    case "issue":
      return { citation, class: "checkable" };
    case "web": {
      const reason = notPublic(citation.url);
      return reason === null ? { citation, class: "checkable" } : testimony(reason);
    }
    case "fact":
      return factIsCheckable(citation.fact)
        ? { citation, class: "checkable" }
        : testimony("the cited fact rests on testimony");
    case "observation":
      return testimony(
        MACHINE_PATH.test(citation.text) && !/\s/.test(citation.text)
          ? "a path on one machine, not in the repository"
          : "a local observation",
      );
    case "document":
      return testimony("needs sign-in");
    case "person":
      return testimony("a person said so");
  }
}

/** The ids of the facts a list of citations cites. */
export function citedFacts(citations: readonly Citation[]): string[] {
  return citations.flatMap((citation) => (citation.kind === "fact" ? [citation.fact] : []));
}

/** The ids of the facts a stored fact's citations cite. */
export function citedBy(citations: readonly ClassedCitation[]): string[] {
  return citedFacts(citations.map((entry) => entry.citation));
}

/** Fields that hold an id or a position, which no scan may rewrite. */
const FIXED_FIELDS = new Set(["kind", "fact", "commit", "lines"]);
/** Fields that are references, not prose: an address in one is part of where the source is. */
const REFERENCE_FIELDS = new Set(["repo", "path", "url"]);

/** The citation with each of its texts passed through `rewrite`, which is told whether the text is a reference. */
export function mapCitationText(
  citation: Citation,
  rewrite: (field: string, value: string, isReference: boolean) => string,
): Citation {
  const entries = Object.entries(citation).map(([field, value]): [string, unknown] =>
    typeof value === "string" && !FIXED_FIELDS.has(field)
      ? [field, rewrite(field, value, REFERENCE_FIELDS.has(field))]
      : [field, value],
  );
  return Object.fromEntries(entries) as Citation;
}

/** A citation in one line, as a result shows it. */
export function citationText(citation: Citation): string {
  switch (citation.kind) {
    case "file": {
      const lines = citation.lines === undefined ? "" : `:${citation.lines}`;
      return `${citation.path}${lines}${citation.commit === undefined ? "" : `@${citation.commit}`}`;
    }
    case "commit":
      return `commit ${citation.commit}`;
    case "pull_request":
      return `${citation.repo} pull request ${citation.number}`;
    case "issue":
      return `${citation.repo} issue ${citation.number}`;
    case "web":
      return citation.url;
    case "fact":
      return `fact ${citation.fact}`;
    case "observation":
      return citation.text;
    case "document":
      return citation.url === undefined ? citation.title : `${citation.title} (${citation.url})`;
    case "person":
      return citation.at === undefined ? citation.who : `${citation.who}, ${citation.at}`;
  }
}

/** A classed citation as a result carries it. */
export function citationView(entry: ClassedCitation): CitationView {
  return {
    ref: citationText(entry.citation),
    kind: entry.citation.kind,
    class: entry.class,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
  };
}
