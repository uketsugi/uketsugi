/**
 * Duplicates: which stored facts are near a claim, which of them say the same thing, and what a
 * merge keeps. The store's search finds the near ones by their text; the rule here decides, and
 * decides only what a rule can be sure of. Two claims are the same when they hold the same words
 * in the same order and the same numbers and identifiers, whatever their case, punctuation and
 * articles. A closer call than that (one word changed) is reported to the agent as `similar` and
 * never merged by rule: one changed word is as often a correction as a rewording.
 *
 * Vectors take no part. A fact's vector is made from its question and citations as well as its
 * claim, so two facts that answer one question from one file are close whatever each says: with
 * the pinned model, contradicting claims stood at 0.98. Whether two different wordings say the
 * same is a judgement for a model step, not for a cosine.
 */
import { citedBy } from "./citations.ts";
import { leaveEmbedJob } from "../context.ts";
import type { ClassedCitation, Fact, ReadScope } from "../domain.ts";
import { canonicalJson, contentHashOf, sha256Hex } from "../hash.ts";
import type { CorePorts } from "../ports.ts";
import type { SearchQuery } from "../search-port.ts";
import type { Store, UnitWrites } from "../store-port.ts";
import { extractIdentifiers, normalizeText } from "../text/analyze.ts";

/** A stored fact whose text holds a stretch at least this similar to the claim, by trigram, is near it. */
const NEAR_TRIGRAM = 0.8;
/** A fact that has a vector enters the candidates only when its own text holds this share of the claim's words. */
const NEAR_COVERAGE = 0.5;
const NEAR_LIMIT = 20;

const ARTICLES = new Set(["a", "an", "the"]);
const NUMBER = /[-+]?\d+(?:[.,:/]\d+)*%?/g;

/** A claim's words in order: lower case, no punctuation, no articles. */
function wordsOf(claim: string): string[] {
  const spaced = normalizeText(claim).replace(/[^\p{L}\p{N}]+/gu, " ");
  return spaced.split(" ").filter((word) => word !== "" && !ARTICLES.has(word));
}

/** What a rewording may not change: the identifiers and the numbers, with their signs and points. */
function fixedTokensOf(claim: string): string[] {
  const numbers = normalizeText(claim).match(NUMBER) ?? [];
  return [...new Set([...extractIdentifiers(claim), ...numbers])].sort();
}

function equal(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Whether two claims say the same thing in the same words: the only likeness a rule merges on. */
export function sameClaim(a: string, b: string): boolean {
  return equal(fixedTokensOf(a), fixedTokensOf(b)) && equal(wordsOf(a), wordsOf(b));
}

/** A fact with text that search still returns. */
export type LiveFact = Fact & { readonly claim: string };

export function isLive(fact: Fact | null): fact is LiveFact {
  return fact !== null && fact.claim !== null && fact.status !== "superseded";
}

/**
 * The live facts of a project whose text all but holds a claim, nearest first: what a publish
 * names as `similar`, and where the rule looks for duplicates.
 */
export async function nearFacts(
  store: Pick<Store, "search" | "facts">,
  scope: ReadScope,
  project: string,
  claim: string,
): Promise<LiveFact[]> {
  const query: SearchQuery = {
    scope,
    project,
    query: claim,
    idents: [],
    // No vector pass: see the head of this file.
    embedding: null,
    vectorCutoff: 1,
    admissionCoverage: NEAR_COVERAGE,
    trigramThreshold: NEAR_TRIGRAM,
    passLimit: NEAR_LIMIT,
  };
  const kept = await store.search.passes(query);
  const candidates = [...new Set(kept.map((row) => row.factId))];
  const ids = (await store.search.trigram(query, candidates)).map((row) => row.factId);
  const facts = await store.facts.getMany(scope, ids);
  return ids.flatMap((id) => facts.filter((fact) => fact.id === id)).filter(isLive);
}

/** The best member of a group of duplicates: confirmed, then with a source anyone can open, then newest. */
export function pickSurvivor<F extends Fact>(group: readonly [F, ...F[]]): F {
  const checkable = (fact: Fact): number =>
    Number(fact.citations.some((entry) => entry.class === "checkable"));
  const ordered = [...group].sort(
    (a, b) =>
      Number(b.status === "confirmed") - Number(a.status === "confirmed") ||
      checkable(b) - checkable(a) ||
      b.updatedAt.getTime() - a.updatedAt.getTime() ||
      b.id.localeCompare(a.id),
  );
  return ordered[0] ?? group[0];
}

/** How a citation is told from another, and what an event may hold of one. */
export function citationHash(entry: ClassedCitation): Promise<string> {
  return sha256Hex(canonicalJson(entry.citation));
}

/**
 * The survivor's citations after it takes a member's: its own, then each of the member's it does
 * not hold already. A member's citation of a fact in the group itself is dropped: the survivor
 * stands for all of them. `taken` is what was added.
 */
export function takeCitations(
  held: readonly ClassedCitation[],
  member: Pick<Fact, "citations">,
  group: ReadonlySet<string>,
): { citations: ClassedCitation[]; taken: ClassedCitation[] } {
  const seen = new Set(held.map((entry) => canonicalJson(entry.citation)));
  const taken = member.citations.filter((entry) => {
    const key = canonicalJson(entry.citation);
    const inGroup = entry.citation.kind === "fact" && group.has(entry.citation.fact);
    return inGroup || seen.has(key) ? false : Boolean(seen.add(key));
  });
  return { citations: [...held, ...taken], taken };
}

/**
 * Replaces a live fact's citations inside a unit, with the facts they name and the hash that
 * follows. A fact's vector is made from its citations too, so the store drops the one it has and a
 * job makes it again.
 */
export async function recite(
  ports: Pick<CorePorts, "ids" | "embedder">,
  unit: UnitWrites,
  fact: LiveFact,
  citations: readonly ClassedCitation[],
  at: Date,
): Promise<void> {
  await unit.facts.setCitations(fact.id, {
    citations,
    citedFacts: citedBy(citations),
    contentHash: await contentHashOf({ ...fact, citations }),
  });
  await leaveEmbedJob(ports, unit, fact.id, at);
}
