/**
 * What a rule cannot tell: whether two different wordings say the same thing, and whether one
 * contradicts the other. A statement is compared only with its person's own facts that a search
 * for it finds on strong evidence, so a model is asked about few pairs, and only its person's own
 * text is sent. A model's "same" merges two stored facts under a ruling their author can revert,
 * and keeps a candidate from being stored; a "contradicts" flags both facts for whoever reads
 * them next. Neither is taken for more than a judgement: every doubtful pair is "different".
 */
import { eventBy, scopeOf } from "../context.ts";
import type { Actor } from "../domain.ts";
import { isLive, type LiveFact } from "../facts/duplicates.ts";
import { mergeDuplicates, MergeStale, notSetApart } from "../jobs/consolidate.ts";
import type { CorePorts } from "../ports.ts";
import { SEARCH_PROFILE } from "../search/fusion.ts";
import { onHeldFacts } from "../sharing.ts";
import { rankFacts } from "../usecases/facts/search.ts";
import type { Reading } from "./candidates.ts";
import { type Pair, type Verdict } from "./chores.ts";

/** How many held facts a statement is compared with. */
const NEAR = 3;
/** The most pairs one judgement is asked about; a session that leaves more has the rest read as different. */
const MOST_PAIRS = 60;

/** A statement to judge: a candidate's claim, or a stored fact's. */
export interface Subject {
  readonly claim: string;
  /** The stored fact the statement is, when it is one: it is never compared with itself. */
  readonly fact: LiveFact | null;
}

/** One comparison a model is asked for. */
export interface Comparison extends Pair {
  /** The position of the subject among those given. */
  readonly subject: number;
  readonly held: LiveFact;
}

/**
 * The person's own live facts near a statement: those a search for it ranks first on the evidence
 * that makes a search result confident, the share of its words they hold or their closeness in
 * meaning. Facts that merely share an identifier are not near.
 */
async function nearOwn(ports: CorePorts, reading: Reading, subject: Subject): Promise<LiveFact[]> {
  const ranking = await rankFacts(ports, reading, subject.claim, SEARCH_PROFILE.passLimit);
  const strong = new Set(
    ranking.ranked
      .filter(
        ({ lexemeCoverage, cosine }) =>
          lexemeCoverage >= SEARCH_PROFILE.strongCoverage ||
          (cosine !== null && cosine >= SEARCH_PROFILE.strongCosine),
      )
      .map((candidate) => candidate.factId),
  );
  const own = ranking.facts.filter(
    (fact): fact is LiveFact =>
      isLive(fact) &&
      strong.has(fact.id) &&
      fact.author === reading.caller.principalId &&
      fact.id !== subject.fact?.id,
  );
  return own.slice(0, NEAR);
}

/** The comparisons to ask for: each subject with the facts near it, a pair of stored facts once. */
export async function comparisonsOf(
  ports: CorePorts,
  reading: Reading,
  subjects: readonly Subject[],
): Promise<Comparison[]> {
  const comparisons: Comparison[] = [];
  const asked = new Set<string>();
  for (const [index, subject] of subjects.entries()) {
    for (const held of await nearOwn(ports, reading, subject)) {
      const pair = [subject.fact?.id ?? `#${index}`, held.id].sort().join(" ");
      if (asked.has(pair) || comparisons.length >= MOST_PAIRS) continue;
      asked.add(pair);
      const n = comparisons.length + 1;
      comparisons.push({ n, a: subject.claim, b: held.claim, subject: index, held });
    }
  }
  return comparisons;
}

/** The held facts a model's verdicts put with one subject, under one verdict. */
export function heldAs(
  comparisons: readonly Comparison[],
  verdicts: ReadonlyMap<number, Verdict>,
  subject: number,
  verdict: Verdict,
): LiveFact[] {
  return comparisons
    .filter((entry) => entry.subject === subject && verdicts.get(entry.n) === verdict)
    .map((entry) => entry.held);
}

/**
 * Merges a stored fact with the facts a model judged to say the same. A fact a person set apart
 * by reverting its merge stays apart, and a merge that finds a fact changed since it was read is
 * left undone: the next reading of a session sees the facts as they are then. Returns how many
 * facts were merged away.
 */
export async function mergeSame(
  ports: CorePorts,
  reading: Reading,
  by: Actor,
  fact: LiveFact,
  same: readonly LiveFact[],
): Promise<number> {
  const group = await notSetApart(ports, scopeOf(reading.caller), [fact, ...same]);
  if (group.length < 2 || !group.some((member) => member.id === fact.id)) return 0;
  try {
    await mergeDuplicates(ports, group, { by, reasonOf: () => "same_meaning" });
    return group.length - 1;
  } catch (error) {
    if (error instanceof MergeStale) return 0;
    throw error;
  }
}

/**
 * Flags two of a person's facts as possibly contradicting each other, in one unit under their
 * lock. A fact that is gone or replaced by then is left out, and a flag already raised stands.
 * Returns how many flags were raised.
 */
export async function flagContradiction(
  ports: CorePorts,
  reading: Reading,
  by: Actor,
  pair: readonly [string, string],
): Promise<number> {
  const { caller, project, session } = reading;
  const who = { caller, project: project.key, at: ports.clock.now(), by };
  return onHeldFacts(ports, who, pair, async (found) => {
    let raised = 0;
    for (const [factId, otherFact] of [pair, [pair[1], pair[0]]] as const) {
      const held = found.get(factId);
      if (held === undefined || !isLive(held.fact)) continue;
      const flag = { id: ports.ids.uuid(), factId, kind: "possible_contradiction" as const };
      if (!(await held.writes.review.raiseFlag({ ...flag, raisedBy: by }))) continue;
      const event = { actor: by, session: session.id };
      await held.writes.append(eventBy(event, "FlagRaised", factId, { ...flag, otherFact }));
      raised += 1;
    }
    return raised;
  });
}
