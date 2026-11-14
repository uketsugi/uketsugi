/**
 * `consolidate`, its rule step: merges its author's duplicates of the fact a write just touched,
 * within its audience and project. The best member of the group survives and takes the others'
 * citations; the others are superseded by it, each under a ruling of its own that Activity can
 * revert. No model runs: the rule merges only claims that say the same thing in the same words.
 *
 * A rule merges one person's own facts and never one person's into another's: a chain of
 * superseded facts is then one author's, so their redaction, and their taking a shared fact back,
 * reaches nobody else's. Another person's same claim is named to the agent as `similar`.
 */
import type { Actor, ClaimedJob } from "../domain.ts";
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
import { MERGE, recordRuling, type MergePayload } from "../facts/rulings.ts";
import type { CorePorts } from "../ports.ts";
import { asPerson, holderOfFact } from "../sharing.ts";
import type { UnitWrites } from "../store-port.ts";
import { settle } from "../usecases/facts/place.ts";

/** The fact the job is about and the live facts that say the same, less any a person's revert set apart. */
async function duplicatesOf(ports: CorePorts, job: ClaimedJob): Promise<LiveFact[]> {
  const scope = { orgId: job.orgId, audienceIds: [job.audienceId] };
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
  const group = [subject, ...same];
  // A person who reverted a fact's merge said it stands by itself: the rule leaves it alone.
  const rulings = await ports.store.review.rulingsOf(
    scope,
    group.map((fact) => fact.id),
  );
  const setApart = new Set(
    rulings
      .filter((ruling) => ruling.decision === MERGE && ruling.revertedBy !== null)
      .map((ruling) => ruling.factId),
  );
  return setApart.has(subject.id) ? [] : group.filter((fact) => !setApart.has(fact.id));
}

/** No model step runs here, whatever runner the server has: the ruling is the rule's. */
const RULE: Actor = { kind: "job", job: "consolidate", runner: "rules" };
const CHANGED = "a fact changed while its duplicates were being merged";

/** Merges the members into the survivor inside one unit. Throws when a fact is not as it was read. */
async function merge(
  ports: Pick<CorePorts, "ids" | "embedder">,
  unit: UnitWrites,
  survivor: LiveFact,
  members: readonly LiveFact[],
  at: Date,
): Promise<void> {
  for (const planned of [survivor, ...members]) {
    const now = await unit.facts.get(planned.id);
    if (!isLive(now) || now.contentHash !== planned.contentHash) {
      throw new Error(CHANGED);
    }
  }
  const group = new Set([survivor, ...members].map((fact) => fact.id));
  let citations = survivor.citations;
  for (const member of members) {
    const took = takeCitations(citations, member, group);
    citations = took.citations;
    await unit.facts.supersede(member.id, survivor.id);
    const payload: Omit<MergePayload, "ruling"> = {
      by: survivor.id,
      was: member.status === "confirmed" ? "confirmed" : "unconfirmed",
      taken: await Promise.all(took.taken.map(citationHash)),
    };
    const reason = member.claimHash === survivor.claimHash ? "same_claim" : "same_words";
    await recordRuling(
      unit,
      { id: ports.ids.uuid(), decision: MERGE, factId: member.id, by: RULE, reasons: [reason] },
      { kind: "FactSuperseded", payload },
    );
  }
  if (citations.length > survivor.citations.length) {
    await recite(ports, unit, survivor, citations, at);
  }
}

/**
 * The job's handler: reads the group outside any unit, then merges it in one, under its author's
 * lock like every other write to a person's facts. A merge changes what a chain is judged by (the
 * survivor takes citations, and a duplicate now goes wherever it goes), so the chain is then put
 * where it belongs.
 */
export async function consolidate(ports: CorePorts, job: ClaimedJob): Promise<void> {
  const [first, ...rest] = await duplicatesOf(ports, job);
  if (first === undefined || rest.length === 0) return;
  const survivor = pickSurvivor([first, ...rest]);
  const members = [first, ...rest].filter((fact) => fact.id !== survivor.id);
  const caller = await ports.store.directory.callerOf(job.orgId, survivor.author);
  if (caller === null) throw new Error("the author of a fact is not a person of this server");
  const who = { caller, project: survivor.project, at: ports.clock.now(), by: RULE };
  await asPerson(ports, who, async (place) => {
    // The shared head first, if there is one: the survivor may take citations of shared facts.
    await place.shared();
    const held = await holderOfFact(place, survivor.id);
    if (held === null) throw new Error(CHANGED);
    await merge(ports, held.writes, survivor, members, place.at);
    await settle(ports, place, [survivor.id]);
  });
}
