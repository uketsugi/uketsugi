import type { PublishFactInput, PublishFactResult } from "@uketsugi/contracts";
import { eventBy, personActor, scopeOf, type CallContext, type Outcome } from "../../context.ts";
import type { Actor, Caller, Fact, FactContent, ProjectRef } from "../../domain.ts";
import { citationView, parseCitations } from "../../facts/citations.ts";
import { nearFacts } from "../../facts/duplicates.ts";
import { forbidden, invalidInput } from "../../failure.ts";
import { armDigest } from "../../digest/arm.ts";
import type { CorePorts } from "../../ports.ts";
import { scanFields } from "../../scan/scanner.ts";
import { asPerson, seenBy, sharedIfSharing, type Place } from "../../sharing.ts";
import { holdCited, landingOf, onFact } from "./place.ts";
import {
  classCitations,
  contentOf,
  correctionOf,
  embedInline,
  enqueueFollowUps,
  liveFactOf,
  scanCitations,
} from "./write.ts";

type PublishOutcome = Outcome<PublishFactResult>;

/** The most near-identical facts a result names. */
const SIMILAR_LIMIT = 3;

/** What a new fact is written from, as a call or a model's answer gives it. */
export type FactWords = Pick<PublishFactInput, "claim" | "citations" | "detail" | "question">;

/** A write's text and citations after the scan: nothing unscanned goes further than this. */
export function scanned(project: ProjectRef, input: FactWords) {
  const parsed = scanCitations(parseCitations(input.citations, project));
  const text = scanFields({ claim: input.claim, detail: input.detail, question: input.question });
  const { claim, detail, question } = text.fields;
  if (claim === null) {
    throw invalidInput("claim is empty.", "Pass one claim that stands by itself.");
  }
  return {
    text: { claim, detail, question },
    citations: parsed.citations,
    replaced: [...text.replaced, ...parsed.replaced],
  };
}

/**
 * A publish that names the caller's own fact in `supersedes` corrects that fact in place, as
 * update_fact would: it keeps its id, and the result names it.
 */
async function correctOwn(
  ports: CorePorts,
  ctx: CallContext,
  supersedes: string,
  draft: ReturnType<typeof scanned>,
): Promise<PublishOutcome> {
  const old = await liveFactOf(ports, ctx, supersedes, {
    absent: () =>
      invalidInput(
        `supersedes names fact ${supersedes}, which is not visible in this project.`,
        "Pass the id of your own fact, as search_facts returned it, or leave supersedes out.",
      ),
    replaced: (fact, head) =>
      invalidInput(
        `Fact ${fact.id} was merged into ${head}.`,
        `Pass ${head} as supersedes: it is the live fact.`,
      ),
  });
  if (old.author !== ctx.caller.principalId) {
    throw forbidden(
      `Fact ${old.id} is another person's.`,
      "Publish your fact without supersedes; a correction of another person's fact is not supported here.",
    );
  }
  const citations = await classCitations(ports, ctx.caller, draft.citations, old.id);
  const correction = await correctionOf(ports, old, { ...draft.text, citations });
  const write = { before: old, correction, at: ports.clock.now() };
  const changed = await onFact(ports, ctx, write);
  return {
    id: old.id,
    status: changed ? "unconfirmed" : old.status,
    created: false,
    citations: citations.map(citationView),
    supersedes: old.id,
    ...(draft.replaced.length === 0 ? {} : { redacted: draft.replaced }),
    ...(await seenBy(ports, ctx.caller, old.id)),
  };
}

/** A new fact as its unit stores it: what was prepared before the unit opened. */
export interface Draft {
  readonly id: string;
  readonly content: FactContent;
  readonly vector: Float32Array | null;
}

/**
 * Whose fact a write stores, and who performs it. An agent's publish is its person's own act in
 * the call's session. A model writes for the person of the session it read: the fact is theirs,
 * the act is the job's, and the fact names that session.
 */
export interface Writer {
  readonly caller: Caller;
  readonly project: string;
  readonly actor: Actor;
  /** The session the write belongs to, as its event records it. */
  readonly session: string;
  /** Set when a model wrote the fact from that session. */
  readonly digested?: boolean;
}

/**
 * Inside the author's unit: their same claim already stored, in whichever audience holds it, or
 * the new fact, written where the person's choice and its citations say at that moment.
 */
async function store(
  ports: CorePorts,
  writer: Writer,
  place: Place,
  draft: Draft,
): Promise<{ fact: Fact; created: boolean }> {
  const { id, content, vector } = draft;
  const { project, session } = writer;
  const author = writer.caller.principalId;
  await holdCited(place, content.citedFacts);
  const shared = await sharedIfSharing(place);
  const existing =
    (await place.own.facts.findByClaimHash(author, project, content.claimHash)) ??
    (await shared?.facts.findByClaimHash(author, project, content.claimHash)) ??
    null;
  if (existing !== null) return { fact: existing, created: false };
  const from = writer.digested === true ? { digestSession: session } : {};
  const writes = await landingOf(place, project, { ...content, ...from, status: "unconfirmed" });
  await writes.facts.insert({ id, project, author, content, vector, ...from });
  const hashes = { id, contentHash: content.contentHash, claimHash: content.claimHash };
  await writes.append(eventBy(writer, "FactPublished", id, hashes));
  await enqueueFollowUps(ports, writes, id, { embed: vector === null, at: place.at });
  const fact = await writes.facts.get(id);
  if (fact === null) throw new Error("a published fact was not readable inside its own unit");
  return { fact, created: true };
}

/**
 * Stores a new fact in one unit on its author's own audience, which decides where it lands and
 * writes it there with its event and its follow-up jobs. The author's same claim in the same
 * project is returned as it is already stored, wherever it is.
 */
export function writeFact(
  ports: CorePorts,
  writer: Writer,
  draft: Draft,
): Promise<{ fact: Fact; created: boolean }> {
  const who = {
    caller: writer.caller,
    project: writer.project,
    at: ports.clock.now(),
    by: writer.actor,
  };
  return asPerson(ports, who, (place) => store(ports, writer, place, draft));
}

/**
 * Publishes one fact (flow F2). The scanner runs first; then the citations are classed, the text
 * analysed and the fact embedded. One unit, on the caller's own audience, then decides where it
 * lands and writes it there with its event and its follow-up jobs: in the shared audience when
 * the caller's person shares the project at that moment and other people can check the fact, and
 * otherwise in the person's own. A repeated publish of the caller's same claim returns the fact
 * already stored, wherever it is. Facts already visible whose text all but holds the claim are
 * named as `similar`.
 */
export async function publishFact(
  ports: CorePorts,
  ctx: CallContext,
  input: PublishFactInput,
): Promise<PublishOutcome> {
  const draft = scanned(ctx.project, input);
  if (input.supersedes !== undefined) return correctOwn(ports, ctx, input.supersedes, draft);

  const citations = await classCitations(ports, ctx.caller, draft.citations);
  const text = { ...draft.text, citations };
  const vector = await embedInline(ports, text);
  const content = await contentOf(text);
  const near = await nearFacts(ports.store, scopeOf(ctx.caller), ctx.project.key, content.claim);

  const writer = {
    caller: ctx.caller,
    project: ctx.project.key,
    actor: personActor(ctx.caller),
    session: ctx.session.id,
  };
  const stored = await writeFact(ports, writer, { id: ports.ids.uuid(), content, vector });
  // What a session published is judged, with a model, against what was held, once it is over.
  if (stored.created) await armDigest(ports, ctx.session, "quiet");

  const fact = stored.fact;
  const similar = near.filter((other) => other.id !== fact.id).slice(0, SIMILAR_LIMIT);
  return {
    id: fact.id,
    status: fact.status,
    created: stored.created,
    citations: fact.citations.map(citationView),
    ...(similar.length === 0
      ? {}
      : { similar: similar.map((other) => ({ id: other.id, claim: other.claim })) }),
    ...(draft.replaced.length === 0 ? {} : { redacted: draft.replaced }),
    ...(await seenBy(ports, ctx.caller, fact.id)),
  };
}
