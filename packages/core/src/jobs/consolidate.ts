/**
 * Merging duplicates. `consolidate` is the rule's job: it merges its author's duplicates of the
 * fact a write just touched, within its audience and project, and only claims that say the same
 * thing in the same words. Whether two wordings say the same is a model's judgement, made when a
 * session is read (`digest`), and merged here by the same unit. Either way the best member of the
 * group survives and takes the others' citations; the others are superseded by it, each under a
 * ruling of its own that Activity can revert.
 *
 * A merge joins one person's own facts and never one person's into another's: a chain of
 * superseded facts is then one author's, so their redaction, and their taking a shared fact back,
 * reaches nobody else's. Another person's same claim is named to the agent as `similar`.
 */
import { scopeOfJob } from "../context.ts";
import type { Actor, ClaimedJob, ReadScope } from "../domain.ts";
import {
  citationHash,
  isLive,
  nearFacts,
  pickSurvivor,
  recite,
  sameClaim,
  takeCitations,
  type LiveFact,
} from "../facts/duplicates.ts";
import { MERGE, recordRuling } from "../facts/rulings.ts";
import type { CorePorts } from "../ports.ts";
import { onHeldFacts } from "../sharing.ts";
import type { UnitWrites } from "../store-port.ts";
import { settle } from "../usecases/facts/place.ts";

/**
 * The members of a group the rule and a model may still merge: a person who reverted a fact's
 * merge said it stands by itself, and it is left alone from then on.
 */
export async function notSetApart<F extends LiveFact>(
  ports: Pick<CorePorts, "store">,
  scope: ReadScope,
  group: readonly F[],
): Promise<F[]> {
  const rulings = await ports.store.review.rulingsOf(
    scope,
    group.map((fact) => fact.id),
  );
  const setApart = new Set(
    rulings
      .filter((ruling) => ruling.decision === MERGE && ruling.revertedBy !== null)
      .map((ruling) => ruling.factId),
  );
  return group.filter((fact) => !setApart.has(fact.id));
}

/** The fact the job is about and the live facts that say the same in the same words, less any set apart. */
async function duplicatesOf(ports: CorePorts, job: ClaimedJob): Promise<LiveFact[]> {
  const scope = scopeOfJob(job);
  const subject = await ports.store.facts.get(scope, job.subject);
  if (!isLive(subject)) return [];
  const near = await nearFacts(ports.store, scope, subject.project, subject.claim);
  const same = near.filter(
    (fact) =>
      fact.id !== subject.id &&
      fact.author === subject.author &&
      sameClaim(subject.claim, fact.claim),
  );
  if (same.length === 0) return [];
  const group = await notSetApart(ports, scope, [subject, ...same]);
  return group.some((fact) => fact.id === subject.id) ? group : [];
}

/** The rule's own rulings: no model is asked here, whatever runner the server has. */
const RULE: Actor = { kind: "job", job: "consolidate", runner: "rules" };

/** A merge left undone because a fact was no longer as it was read. Nothing was changed. */
export class MergeStale extends Error {
  constructor() {
    super("a fact changed while its duplicates were being merged");
    this.name = "MergeStale";
  }
}

/** Who rules that the members of a group say the same, and why each member does. */
export interface MergeRuling {
  readonly by: Actor;
  reasonOf(member: LiveFact, survivor: LiveFact): string;
}

/** Merges the members into the survivor inside one unit. Throws when a fact is not as it was read. */
async function merge(
  ports: Pick<CorePorts, "ids" | "embedder">,
  unit: UnitWrites,
  group: { survivor: LiveFact; members: readonly LiveFact[]; ruling: MergeRuling },
  at: Date,
): Promise<void> {
  const { survivor, members, ruling } = group;
  for (const planned of [survivor, ...members]) {
    const now = await unit.facts.get(planned.id);
    if (!isLive(now) || now.contentHash !== planned.contentHash) {
      throw new MergeStale();
    }
  }
  const ids = new Set([survivor, ...members].map((fact) => fact.id));
  let citations = survivor.citations;
  for (const member of members) {
    const took = takeCitations(citations, member, ids);
    citations = took.citations;
    await unit.facts.supersede(member.id, survivor.id);
    const payload = {
      by: survivor.id,
      was: member.status === "confirmed" ? ("confirmed" as const) : ("unconfirmed" as const),
      taken: await Promise.all(took.taken.map(citationHash)),
    };
    const decided = { decision: MERGE, factId: member.id, by: ruling.by };
    await recordRuling(
      unit,
      { id: ports.ids.uuid(), ...decided, reasons: [ruling.reasonOf(member, survivor)] },
      { kind: "FactSuperseded", payload },
    );
  }
  if (citations.length > survivor.citations.length) {
    await recite(ports, unit, survivor, citations, at);
  }
}

/**
 * Merges one author's facts that say the same thing: read outside any unit, merged in one, under
 * the author's lock like every other write to a person's facts. A merge changes what a chain is
 * judged by (the survivor takes citations, and a duplicate now goes wherever it goes), so the
 * chain is then put where it belongs. A group of one is left as it is. Rejects with `MergeStale`,
 * having changed nothing, when a fact is no longer as it was read or the group is not in one
 * audience.
 */
export async function mergeDuplicates(
  ports: CorePorts,
  group: readonly LiveFact[],
  ruling: MergeRuling,
): Promise<void> {
  const [first, ...rest] = group;
  if (first === undefined || rest.length === 0) return;
  const survivor = pickSurvivor([first, ...rest]);
  const members = group.filter((fact) => fact.id !== survivor.id);
  const caller = await ports.store.directory.callerOf(survivor.orgId, survivor.author);
  if (caller === null) throw new Error("the author of a fact is not a person of this server");
  const who = { caller, project: survivor.project, at: ports.clock.now(), by: ruling.by };
  // The survivor may take citations of shared facts.
  await onHeldFacts(ports, who, [survivor.id], async (found, place) => {
    const held = found.get(survivor.id);
    if (held === undefined) throw new MergeStale();
    await merge(ports, held.writes, { survivor, members, ruling }, place.at);
    await settle(ports, place, [survivor.id]);
  });
}

/** The job's handler: the rule's merge of the duplicates of the fact the job is about. */
export async function consolidate(ports: CorePorts, job: ClaimedJob): Promise<void> {
  await mergeDuplicates(ports, await duplicatesOf(ports, job), {
    by: RULE,
    reasonOf: (member, survivor) =>
      member.claimHash === survivor.claimHash ? "same_claim" : "same_words",
  });
}
