/**
 * Rulings: every decision a person or a job makes about a fact is recorded with who made it, and
 * can be undone. A ruling holds codes and ids, never text; what it did is in the event it wrote,
 * which names the ruling. A ruling moves with its fact and its event stays in the log it was
 * written in, so the event is found by the fact it is about, in the logs its reader may see.
 */
import type { RevertResult, RulingList } from "@uketsugi/contracts";
import {
  eventBy,
  idOf,
  leaveEmbedJob,
  nameOf,
  namesFor,
  personActor,
  scopeOf,
} from "../context.ts";
import type {
  Actor,
  Caller,
  ClassedCitation,
  EventKind,
  Fact,
  RulingDecision,
  StoredEvent,
} from "../domain.ts";
import { forbidden, notFound, unsupported } from "../failure.ts";
import type { CorePorts } from "../ports.ts";
import { asPerson, holderOfFact } from "../sharing.ts";
import type { UnitWrites } from "../store-port.ts";
import { settle } from "../usecases/facts/place.ts";
import { citationHash, recite, type LiveFact } from "./duplicates.ts";

/** The decision a merge of duplicates is recorded as. Its fact is the one merged away. */
export const MERGE: RulingDecision = "merge_duplicate";
/** The decision that undoes another. */
const REVERT: RulingDecision = "revert";
/** How many rulings Activity lists. */
const RULINGS_SHOWN = 50;
/** The longest chain followed: the schema lets none loop, and this ends the walk if one ever did. */
const MAX_CHAIN = 100;

/** What a merge's event holds, so that the merge can be undone: ids, a status and hashes. */
export interface MergePayload {
  readonly ruling: string;
  /** The fact that survived. */
  readonly by: string;
  /** The merged fact's status before. */
  readonly was: "confirmed" | "unconfirmed";
  /** Hashes of the citations the survivor took from the merged fact. */
  readonly taken: readonly string[];
}

/** Records one ruling in a unit, with the event that says what it did. */
export async function recordRuling(
  unit: UnitWrites,
  ruling: {
    id: string;
    decision: RulingDecision;
    factId: string;
    by: Actor;
    reasons: readonly string[];
  },
  event: { kind: EventKind; payload: Record<string, unknown> },
): Promise<void> {
  const { by, ...decided } = ruling;
  const payload = { ...event.payload, ruling: ruling.id };
  await unit.append(eventBy({ actor: by, session: null }, event.kind, ruling.factId, payload));
  await unit.review.record({ ...decided, decidedBy: by });
}

/**
 * The newest rulings the caller can see, as Activity lists them, each saying whether the caller
 * can revert it: a merge of their own facts that nothing has undone.
 */
export async function listRulings(
  ports: Pick<CorePorts, "store">,
  caller: Caller,
): Promise<RulingList> {
  const scope = scopeOf(caller);
  const rulings = await ports.store.review.rulings(scope, RULINGS_SHOWN);
  const people = rulings.flatMap(({ decidedBy }) =>
    decidedBy.kind === "person" ? [decidedBy.id] : [],
  );
  const about = [...new Set(rulings.map((ruling) => ruling.factId))];
  const [names, facts] = await Promise.all([
    namesFor(ports, caller, people),
    ports.store.facts.getMany(scope, about),
  ]);
  const own = new Set(
    facts.filter((fact) => fact.author === caller.principalId).map((fact) => fact.id),
  );
  return {
    rulings: rulings.map(({ decidedBy, ...ruling }) => ({
      id: ruling.id,
      decision: ruling.decision,
      fact: ruling.factId,
      ...(decidedBy.kind === "person"
        ? { actor: nameOf(names, decidedBy.id) }
        : { actor: decidedBy.job, runner: decidedBy.runner }),
      reasons: [...ruling.reasons],
      at: ruling.at.toISOString(),
      reverted_by: ruling.revertedBy,
      revertible: ruling.decision === MERGE && ruling.revertedBy === null && own.has(ruling.factId),
    })),
  };
}

function mergeOf(event: StoredEvent | undefined): MergePayload {
  const payload = event?.payload as Partial<MergePayload> | undefined;
  if (typeof payload?.by !== "string") throw new Error("a merge ruling's event names no survivor");
  return {
    ruling: payload.ruling ?? "",
    by: payload.by,
    was: payload.was === "confirmed" ? "confirmed" : "unconfirmed",
    taken: payload.taken ?? [],
  };
}

/** What one fact ahead of a merged fact holds because of that fact, and gives back. */
interface GivenBack {
  /** The fact ahead, and its citations without those it holds only because of the merge. */
  readonly fact: LiveFact;
  readonly citations: ClassedCitation[];
  /** The fact whose merge into this one handed them on, and their hashes as that merge's event lists them. */
  readonly from: string;
  readonly gave: readonly string[];
}

/** What the fact `by` took when `fact` was merged into it: the list in that merge's entry. */
async function takenBy(unit: UnitWrites, fact: Fact, by: string): Promise<readonly string[]> {
  const merge = (await unit.facts.merges(fact.id)).find((event) => event.payload.by === by);
  return merge === undefined ? [] : mergeOf(merge).taken;
}

/**
 * The facts ahead of a fact in its chain, nearest first, as far as the fact nothing has replaced:
 * each fact a merge handed it on to. Read inside the unit, so the chain is as it stands.
 */
async function aheadOf(unit: UnitWrites, fact: Fact): Promise<Fact[]> {
  const ahead: Fact[] = [];
  let next = fact.supersededBy;
  for (let link = 0; link < MAX_CHAIN && next !== null; link += 1) {
    const found = await unit.facts.get(next);
    if (found === null) break;
    ahead.push(found);
    next = found.supersededBy;
  }
  return ahead;
}

/**
 * What the facts ahead of a merged fact must give back when its merge is undone or its text is
 * taken away. The survivor took the merged fact's citations; if the survivor was merged in turn,
 * the next survivor took them from it, and so on to the head of the chain. Each merge's entry
 * lists what its survivor took, so a fact ahead holds the merged fact's citation only when every
 * link between them passed it on. One a later fact held by itself is in no list, and stays.
 *
 * It is worked out inside the unit that applies it, from the chain and the merges as they stand
 * there: a merge that landed a moment before is in it, and none can land until the unit ends.
 */
async function takenAhead(
  unit: UnitWrites,
  merged: Fact,
  ahead: readonly Fact[],
): Promise<GivenBack[]> {
  const plan: GivenBack[] = [];
  let from = merged;
  let carried: ReadonlySet<string> | null = null;
  for (const next of ahead) {
    if (next.claim === null) break;
    const taken = await takenBy(unit, from, next.id);
    const passed: ReadonlySet<string> = carried ?? new Set(taken);
    const held = new Set(taken.filter((hash) => passed.has(hash)));
    if (held.size === 0) break;
    const hashes = await Promise.all(next.citations.map(citationHash));
    const citations = next.citations.filter((_, index) => !held.has(hashes[index] ?? ""));
    plan.push({ fact: { ...next, claim: next.claim }, citations, from: from.id, gave: [...held] });
    carried = held;
    from = next;
  }
  return plan;
}

/** What a merged fact's chain owes it, as one unit found it: to be applied in that unit by `apply`. */
export interface GiveBack {
  /** Every fact ahead of the merged fact, whether it holds anything of it or not. */
  readonly ahead: readonly Fact[];
  /**
   * Each fact ahead gives back what it holds because of the merge, and the merge that handed it on
   * no longer lists it, so no hash of a citation outlives the citation.
   */
  apply(ports: Pick<CorePorts, "ids" | "embedder">, at: Date): Promise<void>;
}

/**
 * Reads, inside a unit, what the facts ahead of a merged fact hold because of it. Called before
 * the fact is redacted or restored: a redaction takes the lists it reads out of the log.
 */
export async function giveBackOf(unit: UnitWrites, merged: Fact): Promise<GiveBack> {
  const ahead = await aheadOf(unit, merged);
  const plan = merged.claim === null ? [] : await takenAhead(unit, merged, ahead);
  return {
    ahead,
    async apply(ports, at) {
      for (const { fact, citations, from, gave } of plan) {
        if (citations.length < fact.citations.length) {
          await recite(ports, unit, fact, citations, at);
        }
        await unit.facts.forgetTaken(from, gave);
      }
    },
  };
}

/** The refusal of a revert whose merged fact has no text left to bring back. */
function nothingToRestore() {
  return unsupported(
    "The merged fact was redacted since, so there is nothing to restore.",
    "Publish the fact again if it should stand.",
  );
}

/**
 * Reverts a ruling, as Activity offers it to the author of the facts it is about. A merge of
 * duplicates is undone in one unit: the merged fact is live again, every fact ahead of it in its
 * chain gives back the citations it holds because of the merge, the revert is recorded as a ruling
 * of its own, and the restored fact and its old chain are each put where they now belong: one
 * that others cannot check does not stay live where they read. Which facts are ahead, and what
 * each took, is read inside that unit. The rule never merges that fact again. Reverting a ruling
 * already reverted changes nothing.
 */
export async function revertRuling(
  ports: Pick<CorePorts, "store" | "clock" | "ids" | "embedder">,
  caller: Caller,
  rulingId: string,
): Promise<RevertResult> {
  const scope = scopeOf(caller);
  const ruling = await ports.store.review.ruling(scope, idOf(rulingId));
  if (ruling === null) throw notFound("listed ruling", rulingId);
  if (ruling.revertedBy !== null) return { id: ruling.id, reverted: false };
  if (ruling.decision !== MERGE) {
    throw unsupported(
      `A ${ruling.decision} ruling cannot be reverted.`,
      "Only a merge of duplicates has a revert in this version.",
    );
  }
  const { factId } = ruling;
  const read = await ports.store.facts.get(scope, factId);
  if (read === null) throw nothingToRestore();
  if (read.author !== caller.principalId) {
    throw forbidden(
      `Ruling ${ruling.id} merged another person's facts.`,
      "Only their author can undo it; flag the fact if the merge looks wrong.",
    );
  }
  const who = { caller, project: read.project, at: ports.clock.now() };
  const reverted = await asPerson(ports, who, async (place) => {
    // The shared head first, if there is one: what follows may write rows that name shared facts.
    await place.shared();
    const held = await holderOfFact(place, factId);
    if (held === null || held.fact.claim === null) throw nothingToRestore();
    const { writes, fact: merged } = held;
    const id = ports.ids.uuid();
    if (!(await writes.review.revert(ruling.id, id))) return false;
    const owed = await giveBackOf(writes, merged);
    if (merged.supersededBy !== null) {
      const entry = (await writes.facts.merges(factId)).find(
        (event) => event.payload.ruling === ruling.id,
      );
      await writes.facts.restore(merged.id, mergeOf(entry).was);
      await owed.apply(ports, place.at);
    }
    await recordRuling(
      writes,
      { id, decision: REVERT, factId, by: personActor(caller), reasons: [ruling.decision] },
      { kind: "RulingReverted", payload: { reverts: ruling.id } },
    );
    if (!merged.embedded) await leaveEmbedJob(ports, writes, factId, place.at);
    await settle(ports, place, [factId, ...owed.ahead.map((fact) => fact.id)]);
    return true;
  });
  return { id: ruling.id, reverted };
}
