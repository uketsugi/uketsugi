/**
 * What every write of a fact shares: the citations' classes, the fact's hashes and identifiers,
 * its vector, the fact a correction names and what a correction is made of. Reads of the store
 * happen here before a unit opens; what happens inside one is in `place.ts`.
 */
import {
  embedWithin,
  eventBy,
  idOf,
  leaveEmbedJob,
  liveHeads,
  scopeOf,
  type CallContext,
} from "../../context.ts";
import type { Actor, Caller, Citation, ClassedCitation, Fact, FactContent } from "../../domain.ts";
import {
  citationText,
  citedBy,
  citedFacts,
  classify,
  mapCitationText,
} from "../../facts/citations.ts";
import type { LiveFact } from "../../facts/duplicates.ts";
import { invalidInput, type ToolFailure } from "../../failure.ts";
import { claimHashOf, contentHashOf } from "../../hash.ts";
import type { CorePorts } from "../../ports.ts";
import { scanText, type Replacement } from "../../scan/scanner.ts";
import type { UnitWrites, VectorChange } from "../../store-port.ts";
import { extractIdentifiers } from "../../text/analyze.ts";

/** How long a write waits for its fact's vector before it leaves the fact to the embed job. */
const EMBED_BUDGET_MS = 1500;

/**
 * Who raises "source changed" on the facts that cite a fact: the source check's rule, applied in
 * the unit that changed the source.
 */
const SOURCE_CHECK: Actor = { kind: "job", job: "check_sources", runner: "rules" };

/** Scans the texts of a call's citations. A path or a URL is a reference: only secrets leave it. */
export function scanCitations(citations: readonly Citation[]): {
  citations: Citation[];
  replaced: Replacement[];
} {
  const replaced: Replacement[] = [];
  const scanned = citations.map((citation, index) =>
    mapCitationText(citation, (field, value, isReference) => {
      const result = scanText(value, { secretsOnly: isReference });
      const where = `citations[${index}].${field}`;
      replaced.push(...result.rules.map((rule) => ({ field: where, rule })));
      return result.text;
    }),
  );
  return { citations: scanned, replaced };
}

/**
 * Classes a call's citations. A cited fact must be one the caller can see and that still has its
 * text; a superseded one is cited as the live fact at the head of its chain. `self` is the fact
 * being written, which may not cite itself.
 */
export async function classCitations(
  ports: Pick<CorePorts, "store">,
  caller: Caller,
  citations: readonly Citation[],
  self?: string,
): Promise<ClassedCitation[]> {
  const scope = scopeOf(caller);
  const ids = citedFacts(citations);
  const cited = ids.length === 0 ? [] : await ports.store.facts.getMany(scope, ids);
  const heads = await liveHeads(ports, scope, cited);
  const live = heads.size === 0 ? [] : await ports.store.facts.getMany(scope, [...heads.values()]);
  const resolve = (id: string): Fact | undefined => {
    const head = heads.get(id);
    const from = head === undefined ? cited : live;
    return from.find((fact) => fact.id === (head ?? id));
  };
  return citations.map((citation) => {
    if (citation.kind !== "fact") return classify(citation, () => false);
    const fact = resolve(citation.fact);
    if (fact !== undefined && fact.id === self) {
      throw invalidInput("A fact cannot cite itself.", "Cite the source the fact rests on.");
    }
    if (fact === undefined || fact.claim === null) {
      throw invalidInput(
        `A citation names fact ${citation.fact}, which is not visible here.`,
        "Cite an existing fact by the id search_facts returned, or cite the source itself.",
      );
    }
    const checkable = fact.citations.some((entry) => entry.class === "checkable");
    return classify({ kind: "fact", fact: fact.id }, () => checkable);
  });
}

/** What a fact says: what is hashed, analysed, embedded and stored. */
export type FactText = Pick<LiveFact, "claim" | "detail" | "question" | "citations">;

/**
 * A fact's text with its derived keys: both hashes, the identifiers its own text holds (a question
 * is someone's wording of what it answers, and never makes a fact findable by an identifier) and
 * the facts its citations name.
 */
export async function contentOf(text: FactText): Promise<FactContent> {
  const { claim, detail, question, citations } = text;
  const [contentHash, claimHash] = await Promise.all([contentHashOf(text), claimHashOf(claim)]);
  const own = [claim, detail].filter((part) => part !== null);
  const idents = extractIdentifiers(own.join("\n"));
  const cited = citedBy(citations);
  return { claim, detail, question, citations, contentHash, claimHash, idents, citedFacts: cited };
}

/**
 * What a fact's vector is made from: the question it answers, its claim and each citation as a
 * result shows it, one to a line. A search is a question, and where an answer lives says what it
 * is about, so the three together bring a fact nearer the questions it answers than its claim
 * alone does (held-out hit@5 on the team set: 67 of 70 against 57).
 */
export function embedTextOf(fact: Pick<FactText, "claim" | "question" | "citations">): string {
  const cited = fact.citations.map((entry) => citationText(entry.citation));
  return [fact.question, fact.claim, ...cited].filter((part) => part !== null).join("\n");
}

/**
 * A fact's vector: the one way a fact is embedded, inside a write and by the embed job alike.
 * Rejects when no model is installed, the model fails or it does not answer within `budgetMs`.
 */
export function embedFact(
  ports: Pick<CorePorts, "embedder" | "clock">,
  fact: Pick<FactText, "claim" | "question" | "citations">,
  budgetMs: number,
): Promise<Float32Array> {
  return embedWithin(ports, embedTextOf(fact), "document", budgetMs);
}

/** The fact's vector for a write, or null: the write goes ahead and the embed job takes the fact. */
export function embedInline(
  ports: Pick<CorePorts, "embedder" | "clock">,
  fact: Pick<FactText, "claim" | "question" | "citations">,
): Promise<Float32Array | null> {
  return embedFact(ports, fact, EMBED_BUDGET_MS).catch(() => null);
}

/** The jobs a changed fact leaves: its vector when the call did not make one, and a look for duplicates. */
export async function enqueueFollowUps(
  ports: Pick<CorePorts, "ids" | "embedder">,
  unit: UnitWrites,
  factId: string,
  options: { embed: boolean; at: Date },
): Promise<void> {
  if (options.embed) await leaveEmbedJob(ports, unit, factId, options.at);
  const job = { id: ports.ids.uuid(), subject: factId, runAfter: options.at };
  await unit.enqueue({ ...job, kind: "consolidate" });
}

/**
 * Flags the live facts that cite `sourceId` "source changed": doubt travels one step, to the
 * facts that rest on what changed. A fact already flagged for this source is left as it is.
 */
export async function flagCiting(
  ports: Pick<CorePorts, "ids">,
  unit: UnitWrites,
  session: string | null,
  sourceId: string,
): Promise<void> {
  for (const factId of await unit.facts.citing(sourceId)) {
    const flag = { id: ports.ids.uuid(), factId, kind: "source_changed" as const };
    if (!(await unit.review.raiseFlag({ ...flag, raisedBy: SOURCE_CHECK }))) continue;
    const by = { actor: SOURCE_CHECK, session };
    await unit.append(eventBy(by, "FlagRaised", factId, { ...flag, otherFact: sourceId }));
  }
}

/**
 * The fact a write names: one with its text, in the call's project, that nothing has replaced.
 * Each tool words the two refusals its own way: `absent` for a fact the caller cannot see here,
 * `replaced` for one whose chain has a live fact at its head.
 */
export async function liveFactOf(
  ports: Pick<CorePorts, "store">,
  ctx: CallContext,
  id: string,
  refusals: { absent(): ToolFailure; replaced(fact: Fact, head: string): ToolFailure },
): Promise<LiveFact> {
  const scope = scopeOf(ctx.caller);
  const fact = await ports.store.facts.get(scope, idOf(id));
  if (fact === null || fact.claim === null || fact.project !== ctx.project.key) {
    throw refusals.absent();
  }
  const head = (await liveHeads(ports, scope, [fact])).get(fact.id);
  if (head !== undefined) throw refusals.replaced(fact, head);
  return { ...fact, claim: fact.claim };
}

/** A correction as it is prepared before its unit opens: the fact's new content, and what becomes of its vector. */
export interface Correction {
  readonly content: FactContent;
  readonly vector: VectorChange;
}

/**
 * Prepares the author's correction of `fact` to `text`. The fact is embedded again only when what
 * a vector is made from changed; a model that does not answer in time leaves it to the embed job.
 */
export async function correctionOf(
  ports: Pick<CorePorts, "embedder" | "clock">,
  fact: LiveFact,
  text: FactText,
): Promise<Correction> {
  const kept = embedTextOf(text) === embedTextOf(fact);
  return { content: await contentOf(text), vector: kept ? "kept" : await embedInline(ports, text) };
}
