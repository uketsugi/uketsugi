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
import type { HeldBack } from "../sharing.ts";
import { citationView } from "./citations.ts";

type ReadPorts = Pick<CorePorts, "store">;

/** Who can see a fact the reader can see: everyone on the server, or the reader alone. */
function audienceOf(reader: Caller, fact: Fact): "private" | "shared" {
  return fact.audienceId === reader.sharedAudienceId ? "shared" : "private";
}

/**
 * Facts as a result carries them to one reader: with their trust label, open flags, newest
 * confirmation, who wrote them (`you` for the reader's own), on a server with several people who
 * can see them, and, for a superseded one, the live fact at the head of its chain. A stub has no view. `heads` is `liveHeads` of the facts, for a
 * caller that has read it already.
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
  const [confirmations, flags, names, successors] = await Promise.all([
    ports.store.review.confirmations(scope, ids),
    ports.store.review.openFlags(scope, ids),
    namesFor(ports, reader, authors),
    heads ?? liveHeads(ports, scope, facts),
  ]);
  return facts.flatMap((fact) => {
    if (fact.claim === null) return [];
    const checks = confirmations.filter((entry) => entry.factId === fact.id);
    const newest = Math.max(...checks.map((entry) => entry.at.getTime()));
    const kinds = flags.filter((entry) => entry.factId === fact.id).map((entry) => entry.kind);
    const head = successors.get(fact.id);
    return [
      {
        id: fact.id,
        claim: fact.claim,
        ...(fact.detail === null ? {} : { detail: fact.detail }),
        ...(fact.question === null ? {} : { question: fact.question }),
        citations: fact.citations.map(citationView),
        status: fact.status,
        flags: [...new Set(kinds)],
        trust: fact.status === "confirmed" ? ("reviewed" as const) : ("unreviewed" as const),
        author: nameOf(names, fact.author),
        ...(reader.sharedAudienceId === null ? {} : { audience: audienceOf(reader, fact) }),
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
  return `${citation.ref} (${citation.class}${reason})`;
}

function factLines(fact: FactView): string[] {
  const flags = fact.flags.length === 0 ? "" : ` · flagged: ${fact.flags.join(", ")}`;
  const seen = fact.audience === undefined ? "" : ` · ${fact.audience}`;
  return [
    `${fact.id} · ${fact.claim}`,
    ...(fact.detail === undefined ? [] : [`  ${fact.detail}`]),
    `  citations: ${fact.citations.map(citationLine).join("; ")}`,
    `  ${fact.trust} · ${fact.status}${flags} · by ${fact.author}${seen} · ${fact.updated_at}`,
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
  const head = `${result.supersedes === undefined ? verb : "corrected in place"} ${result.id}`;
  const similar = (result.similar ?? []).map(
    (fact) =>
      `similar: ${fact.id} · ${fact.claim} (confirm that fact with update_fact if it says the same)`,
  );
  return [
    `${head} · ${result.status}`,
    ...result.citations.map(
      (citation, index) => `citation ${index + 1}: ${citationLine(citation)}`,
    ),
    ...similar,
    ...redactedLine(result.redacted),
    ...seenLine(result),
    ...footer(result),
  ].join("\n");
}

export function renderUpdate(result: UpdateFactResult): string {
  const flags = result.flags.length === 0 ? "" : ` · flagged: ${result.flags.join(", ")}`;
  return [
    `updated ${result.id} · ${result.status}${flags}`,
    ...(result.citations ?? []).map(
      (citation, index) => `citation ${index + 1}: ${citationLine(citation)}`,
    ),
    ...redactedLine(result.redacted),
    ...seenLine(result),
    ...footer(result),
  ].join("\n");
}
