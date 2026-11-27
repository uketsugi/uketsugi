/**
 * Facts as a result carries them and as their readers read them: records in, the contract's
 * shapes and the result's text out. What memory returns is data for the reader, never an
 * instruction.
 */
import {
  NOTHING_FOUND,
  type ApiFact,
  type Citation,
  type Fact as FactView,
  type PublishFactResult,
  type SearchFactsResult,
  type UpdateFactResult,
} from "@uketsugi/contracts";
import { liveHeads, nameOf, namesFor, scopeOf } from "../context.ts";
import type { Caller, Fact } from "../domain.ts";
import type { CorePorts } from "../ports.ts";
import { footer } from "../render.ts";
import { audienceOf, canShare, type HeldBack } from "../sharing.ts";
import { citationView } from "./citations.ts";

type ReadPorts = Pick<CorePorts, "store">;

/** The display id of each session a model wrote one of the facts from, by the session's id. */
async function digestedFrom(
  ports: ReadPorts,
  reader: Caller,
  facts: readonly Fact[],
): Promise<ReadonlyMap<string, string>> {
  const ids = facts.flatMap((fact) => (fact.digestSession === null ? [] : [fact.digestSession]));
  if (ids.length === 0) return new Map();
  const sessions = await ports.store.sessions.byIds(reader.orgId, [...new Set(ids)]);
  return new Map(sessions.map((session) => [session.id, session.displayId]));
}

/**
 * Facts as a result carries them to one reader: with their trust label, open flags, newest
 * confirmation, who wrote them (`you` for the reader's own), the session a model wrote them from
 * where one did, on a server with several people who can see them, and, for a superseded one, the
 * live fact at the head of its chain. A stub has no view. `heads` is `liveHeads` of the facts, for
 * a caller that has read it already.
 */
export async function factViews(
  ports: ReadPorts,
  reader: Caller,
  facts: readonly Fact[],
  heads?: ReadonlyMap<string, string>,
): Promise<FactView[]> {
  const scope = scopeOf(reader);
  const ids = facts.map((fact) => fact.id);
  const authors = facts.map((fact) => fact.author);
  const [confirmations, flags, names, successors, sessions] = await Promise.all([
    ports.store.review.confirmations(scope, ids),
    ports.store.review.openFlags(scope, ids),
    namesFor(ports, reader, authors),
    heads ?? liveHeads(ports, scope, facts),
    digestedFrom(ports, reader, facts),
  ]);
  return facts.flatMap((fact) => {
    if (fact.claim === null) return [];
    const checks = confirmations.filter((entry) => entry.factId === fact.id);
    const newest = Math.max(...checks.map((entry) => entry.at.getTime()));
    const kinds = flags.filter((entry) => entry.factId === fact.id).map((entry) => entry.kind);
    const head = successors.get(fact.id);
    const from = fact.digestSession === null ? undefined : sessions.get(fact.digestSession);
    return [
      {
        id: fact.id,
        claim: fact.claim,
        ...(fact.detail === null ? {} : { detail: fact.detail }),
        ...(fact.question === null ? {} : { question: fact.question }),
        citations: fact.citations.map((entry) => citationView(entry, fact.project)),
        status: fact.status,
        flags: [...new Set(kinds)],
        trust: fact.status === "confirmed" ? ("reviewed" as const) : ("unreviewed" as const),
        author: nameOf(names, fact.author),
        ...(from === undefined ? {} : { from_session: from }),
        ...(canShare(reader) ? { audience: audienceOf(reader, fact) } : {}),
        updated_at: fact.updatedAt.toISOString(),
        ...(checks.length === 0 ? {} : { confirmed_at: new Date(newest).toISOString() }),
        ...(head === undefined ? {} : { superseded_by: head }),
      },
    ];
  });
}

/** Facts in the dashboard's shape, in the order given. A redacted fact is there as a stub, so the person sees it was. */
export async function apiFacts(
  ports: ReadPorts,
  caller: Caller,
  facts: readonly Fact[],
): Promise<ApiFact[]> {
  const stubAuthors = facts.filter((fact) => fact.claim === null).map((fact) => fact.author);
  const heads = await liveHeads(ports, scopeOf(caller), facts);
  const [views, names] = await Promise.all([
    factViews(ports, caller, facts, heads),
    namesFor(ports, caller, stubAuthors),
  ]);
  return facts.map((fact) => {
    const view = views.find((entry) => entry.id === fact.id);
    return {
      id: fact.id,
      project: fact.project,
      audience: audienceOf(caller, fact),
      claim: fact.claim,
      detail: fact.detail,
      question: fact.question,
      citations: view?.citations ?? [],
      status: fact.status,
      flags: view?.flags ?? [],
      trust: view?.trust ?? "unreviewed",
      author: view?.author ?? nameOf(names, fact.author),
      from_session: view?.from_session ?? null,
      own: fact.author === caller.principalId,
      redacted: fact.redactedAt !== null,
      created_at: fact.createdAt.toISOString(),
      updated_at: fact.updatedAt.toISOString(),
      confirmed_at: view?.confirmed_at ?? null,
      superseded_by: heads.get(fact.id) ?? null,
    };
  });
}

function citationLine(citation: Citation): string {
  const reason = citation.reason === undefined ? "" : `, ${citation.reason}`;
  // A person's words are shown with the line, as the person said them: the text says what is
  // kept, and a harness that hands its model this text and not the JSON loses nothing.
  const said =
    citation.kind === "person" && citation.quote !== undefined ? `: "${citation.quote}"` : "";
  return `${citation.ref} (${citation.class}${reason})${said}`;
}

/**
 * Who a fact is by, as a result says it. One a model wrote from a session says so: nobody checked
 * it against its source when it was written, which is for its reader to weigh. No recorded run
 * held such a fact, so the words every other fact is shown in are as they were measured.
 */
function byLine(fact: FactView): string {
  const model =
    fact.from_session === undefined ? "" : `, written by a model from session ${fact.from_session}`;
  return `by ${fact.author}${model}`;
}

/** What a fact's flags add to its status, as a result and an export show it; nothing when it has none. */
export function flaggedSuffix(flags: readonly string[]): string {
  return flags.length === 0 ? "" : ` · flagged: ${flags.join(", ")}`;
}

function factLines(fact: FactView): string[] {
  const flags = flaggedSuffix(fact.flags);
  const seen = fact.audience === undefined ? "" : ` · ${fact.audience}`;
  return [
    `${fact.id} · ${fact.claim}`,
    ...(fact.detail === undefined ? [] : [`  ${fact.detail}`]),
    `  citations: ${fact.citations.map(citationLine).join("; ")}`,
    `  ${fact.trust} · ${fact.status}${flags} · ${byLine(fact)}${seen} · ${fact.updated_at}`,
  ];
}

/**
 * Who can see the fact a publish or an update has just written, on a server with several people:
 * the line under it says how the project is treated, and a fact in a shared project can still be
 * its author's alone. These texts are in none of the recorded runs; a host with one person never
 * prints them.
 */
const SEEN: Record<"private" | "shared", string> = {
  shared: "shared · everyone on this server sees it",
  private: "private · only your person sees it",
};
const HELD_BACK_BY: Record<HeldBack, string> = {
  model_unchecked: "a model wrote it and nobody has checked it",
  no_source: "none of its citations is checkable",
  cites_private: "it cites a fact others cannot see",
  merged_word: "a duplicate merged into it has no checkable citation",
};

function seenLine(result: Pick<PublishFactResult, "audience" | "private_because">): string[] {
  const { audience, private_because: because } = result;
  if (audience === undefined) return [];
  const why = because === undefined || because === "project" ? "" : ` · ${HELD_BACK_BY[because]}`;
  return [`fact: ${SEEN[audience]}${why}`];
}

/**
 * A search result as the agent reads it. A result that shows nothing is the nothing-found reply.
 * One whose matches are all weak leads with a line that says so, and never with "nothing found":
 * the facts under it are there to be checked. Either way it states how many matched and are shown.
 */
export function renderSearch(result: SearchFactsResult): string {
  const none = result.facts.length === 0;
  const lead = result.message ?? (none ? NOTHING_FOUND : undefined);
  const head = [
    ...(lead === undefined ? [] : [lead]),
    ...(none
      ? []
      : [
          `${result.matched} matched · ${result.shown} shown · confidence ${result.confidence}`,
          ...result.facts.flatMap(factLines),
        ]),
  ];
  return [...head, ...footer(result)].join("\n");
}

/** What the scanner replaced, so the agent can tell its person and not send the same text again. */
function redactedLine(replaced: PublishFactResult["redacted"]): string[] {
  if (replaced === undefined || replaced.length === 0) return [];
  const what = replaced.map((entry) => `${entry.field} (${entry.rule})`).join(", ");
  return [`redacted before storing: ${what}`];
}

export function renderPublish(result: PublishFactResult): string {
  const verb = result.created ? "published" : "already published";
  const done = result.supersedes === undefined ? verb : "corrected in place";
  const head = `${done} ${result.id} · ${result.status}`;
  const similar = (result.similar ?? []).map(
    (fact) =>
      `similar: ${fact.id} · ${fact.claim} (confirm that fact with update_fact if it says the same)`,
  );
  const lost =
    result.lost_confirmation === true
      ? ["was confirmed; the citation added made it unconfirmed again"]
      : [];
  return [head, ...lost, ...writtenLines(result, result.citations, similar)].join("\n");
}

export function renderUpdate(result: UpdateFactResult): string {
  const head = `updated ${result.id} · ${result.status}${flaggedSuffix(result.flags)}`;
  return [head, ...writtenLines(result, result.citations ?? [], [])].join("\n");
}

/**
 * A write's result after its first line: its citations, numbered, the lines its tool adds, what
 * the scan replaced, who can see the fact, and the footer.
 */
function writtenLines(
  result: PublishFactResult | UpdateFactResult,
  citations: readonly Citation[],
  added: readonly string[],
): string[] {
  return [
    ...citations.map((citation, index) => `citation ${index + 1}: ${citationLine(citation)}`),
    ...added,
    ...redactedLine(result.redacted),
    ...seenLine(result),
    ...footer(result),
  ];
}
