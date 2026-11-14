/**
 * Where a person's facts and tasks are, decided and done inside the person's unit (`asPerson`):
 * where a new fact lands, the one unit that changes a fact in place, and the moves between a
 * person's own audience and the shared one. Nothing here commits in one audience and moves in a
 * second step: a correction that changes whether others can check a fact is written while the
 * fact is in the person's own audience, before it is shared or after it has come home.
 */
import { eventBy, eventOf, type CallContext } from "../../context.ts";
import type { EventKind, Fact, Task } from "../../domain.ts";
import { citedBy } from "../../facts/citations.ts";
import { isLive, type LiveFact } from "../../facts/duplicates.ts";
import { changedMeanwhile, ToolFailure } from "../../failure.ts";
import type { CorePorts } from "../../ports.ts";
import {
  asPerson,
  heldBack,
  holderOfFact,
  requireSharing,
  sharedIfSharing,
  type Cited,
  type Place,
} from "../../sharing.ts";
import type { UnitWrites } from "../../store-port.ts";
import { enqueueFollowUps, flagCiting, type Correction } from "./write.ts";

type MovePorts = Pick<CorePorts, "ids" | "embedder">;

/**
 * Where a fact nothing has replaced belongs now: in the shared audience when its person shares
 * its project and nothing holds it back (`heldBack`), and otherwise in the person's own. `behind`
 * is every fact it replaced.
 */
export async function landingOf(
  place: Place,
  project: string,
  fact: Cited,
  behind: readonly Fact[] = [],
): Promise<UnitWrites> {
  const shared = await sharedIfSharing(place, project);
  if (shared === null) return place.own;
  const held = await heldBack(fact, behind, (ids) => place.own.facts.getMany(ids));
  return held === null ? shared : place.own;
}

/**
 * Before a write stores citations of facts: takes the shared head, so that no cited fact can
 * leave while the rows that name it are written (a unit that took the head only afterwards could
 * wait for another person's withdrawal while that withdrawal waits for it), and refuses the write
 * when a fact it newly cites has left meanwhile. A citation the fact already had is not held to
 * that: its author keeps correcting a fact whose source was taken back, and drops the citation
 * when they choose to. `kept` are the facts cited before the write.
 */
export async function holdCited(
  place: Place,
  cited: readonly string[],
  kept: readonly string[] = [],
): Promise<void> {
  if (cited.length === 0 || place.caller.sharedAudienceId === null) return;
  const shared = await place.shared();
  const added = cited.filter((id) => !kept.includes(id));
  const held = [
    ...(await place.own.facts.getMany(added)),
    ...(shared === null ? [] : await shared.facts.getMany(added)),
  ];
  const seen = new Set(held.map((fact) => fact.id));
  if (added.every((id) => seen.has(id))) return;
  throw new ToolFailure("unavailable", {
    what: "A fact this one cites stopped being visible while the call was being prepared.",
    meaning: "Its author took it back or it was removed, so nothing was written.",
    next: "Send the same call again: it will say which citation no longer holds.",
  });
}

/** The records a move takes: facts by the fact at the head of each chain, and tasks. */
export interface Records {
  readonly facts: readonly Fact[];
  readonly tasks: readonly Task[];
}

const KINDS = {
  shared: { fact: "FactShared", task: "TaskShared" },
  withdrawn: { fact: "FactWithdrawn", task: "TaskWithdrawn" },
} as const satisfies Record<string, { fact: EventKind; task: EventKind }>;

/** Writes a move in both logs it touches. The entry in the log a record leaves says so, for whoever reads both. */
async function logMove(
  place: Place,
  kinds: (typeof KINDS)[keyof typeof KINDS],
  moved: { facts: readonly string[]; tasks: readonly string[] },
  logs: { left: UnitWrites; joined: UnitWrites },
): Promise<void> {
  const who = { actor: place.by, session: null };
  const subjects = [
    ...moved.facts.map((id) => ({ id, kind: kinds.fact })),
    ...moved.tasks.map((id) => ({ id, kind: kinds.task })),
  ];
  for (const { id, kind } of subjects) {
    await logs.left.append(eventBy(who, kind, id, { left: true }));
    await logs.joined.append(eventBy(who, kind, id));
  }
}

/** How many live facts and tasks a move took. */
function countOf(records: Records, moved: { facts: string[]; tasks: string[] }) {
  const went = new Set(moved.facts);
  const facts = records.facts.filter((fact) => isLive(fact) && went.has(fact.id));
  return { live: facts, facts: facts.length, tasks: moved.tasks.length };
}

/** The live facts of one audience that cite any of the given facts. */
async function citing(writes: UnitWrites, ids: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const id of ids) found.push(...(await writes.facts.citing(id)));
  return found;
}

/**
 * Moves a person's records from their own audience to the shared one, and then those of their
 * facts that only a citation of what moved held back. Returns how many moved.
 */
export async function share(
  ports: MovePorts,
  place: Place,
  shared: UnitWrites,
  records: Records,
): Promise<{ facts: number; tasks: number }> {
  if (records.facts.length + records.tasks.length === 0) return { facts: 0, tasks: 0 };
  const went = await place.own.move({
    from: place.own.audienceId,
    to: shared.audienceId,
    facts: records.facts.map((fact) => fact.id),
    tasks: records.tasks.map((task) => task.id),
  });
  await logMove(place, KINDS.shared, went, { left: place.own, joined: shared });
  const { live, ...moved } = countOf(records, went);
  // A fact that arrives looks for its author's duplicates here, and for a vector if it has none.
  for (const fact of live) {
    await enqueueFollowUps(ports, shared, fact.id, { embed: !fact.embedded, at: place.at });
  }
  const followed = await settle(ports, place, await citing(place.own, went.facts));
  return { facts: moved.facts + followed, tasks: moved.tasks };
}

/**
 * Moves a person's records from the shared audience back to their own, and with them those of
 * their shared facts that cite what moved. Other people's confirmations do not go with a fact,
 * and the shared facts that cite it are flagged: their source is no longer one their readers can
 * open. Returns how many moved.
 */
export async function withdraw(
  ports: MovePorts,
  place: Place,
  shared: UnitWrites,
  records: Records,
): Promise<{ facts: number; tasks: number }> {
  if (records.facts.length + records.tasks.length === 0) return { facts: 0, tasks: 0 };
  for (const fact of records.facts) {
    await shared.review.clearConfirmations(fact.id, fact.author);
    if (fact.status === "confirmed") await shared.facts.setStatus(fact.id, "unconfirmed");
  }
  const went = await place.own.move({
    from: shared.audienceId,
    to: place.own.audienceId,
    facts: records.facts.map((fact) => fact.id),
    tasks: records.tasks.map((task) => task.id),
  });
  await logMove(place, KINDS.withdrawn, went, { left: shared, joined: place.own });
  for (const id of went.facts) await flagCiting(ports, shared, null, id);
  const { live, ...moved } = countOf(records, went);
  for (const fact of live) {
    await enqueueFollowUps(ports, place.own, fact.id, { embed: !fact.embedded, at: place.at });
  }
  const followed = await settle(ports, place, await citing(shared, went.facts));
  return { facts: moved.facts + followed, tasks: moved.tasks };
}

/**
 * Puts the caller's own facts where they now belong, each by its own project's choice, and
 * returns how many moved: what a write has just changed (a merge, its undoing, a give-back or a
 * move of a fact they cite) can leave a fact others cannot check where they read, or make a
 * private one theirs to see. A fact something has replaced is where the fact that replaced it is;
 * another person's fact is left as it is.
 */
export async function settle(
  ports: MovePorts,
  place: Place,
  ids: readonly string[],
): Promise<number> {
  const shared = ids.length === 0 ? null : await place.shared();
  if (shared === null) return 0;
  let moved = 0;
  for (const id of new Set(ids)) {
    const held = await holderOfFact(place, id);
    if (held === null || !isLive(held.fact)) continue;
    const { fact, writes } = held;
    if (fact.author !== place.caller.principalId) continue;
    const want = await landingOf(place, fact.project, fact, await writes.facts.behind(fact.id));
    if (want === writes) continue;
    const records = { facts: [fact], tasks: [] };
    moved += (await (want === place.own ? withdraw : share)(ports, place, shared, records)).facts;
  }
  return moved;
}

/**
 * The author's correction, inside a unit: the fact is rewritten in place and keeps its id, other
 * people's confirmations are cleared, and the facts that cite it are flagged. The old wording is
 * not kept; the event holds the hashes before and after.
 */
async function rewrite(
  ports: MovePorts,
  unit: UnitWrites,
  ctx: Pick<CallContext, "caller" | "session">,
  fact: Fact,
  correction: Correction,
  at: Date,
): Promise<void> {
  const { content, vector } = correction;
  await unit.facts.rewrite(fact.id, content, vector);
  await unit.review.clearConfirmations(fact.id, fact.author);
  if (fact.status === "confirmed") await unit.facts.setStatus(fact.id, "unconfirmed");
  const hashes = { before: fact.contentHash, after: content.contentHash };
  await unit.append(eventOf(ctx, "FactRewritten", fact.id, hashes));
  await flagCiting(ports, unit, ctx.session.id, fact.id);
  const embed = vector === null || (vector === "kept" && !fact.embedded);
  await enqueueFollowUps(ports, unit, fact.id, { embed, at });
}

/**
 * Corrects a fact where its new citations say it belongs, and returns where that is. A fact that
 * is shared and will not be is taken home first, so the new text is never written where others
 * read; one that is private and will be shared is corrected first, so the log others read holds
 * no hash of the text it had.
 */
async function correctWhereItBelongs(
  ports: MovePorts,
  place: Place,
  ctx: Pick<CallContext, "caller" | "session">,
  held: { writes: UnitWrites; fact: LiveFact },
  correction: Correction,
): Promise<UnitWrites> {
  const { fact } = held;
  await holdCited(place, correction.content.citedFacts, citedBy(fact.citations));
  const behind = await held.writes.facts.behind(fact.id);
  const want = await landingOf(place, fact.project, correction.content, behind);
  // Reached only when the fact is, or is to be, in the shared audience: its head is held by then.
  const shared = held.writes === place.own && want === place.own ? null : await place.shared();
  const records = { facts: [fact], tasks: [] };
  let writes = held.writes;
  if (shared !== null && writes === shared && want === place.own) {
    await withdraw(ports, place, shared, records);
    writes = place.own;
  }
  await rewrite(ports, writes, ctx, fact, correction, place.at);
  if (shared !== null && writes === place.own && want === shared) {
    await share(ports, place, shared, records);
    writes = shared;
  }
  return writes;
}

/**
 * The one unit on the fact a write read as `before`: the author's correction, if the call makes
 * one, and then whatever else the call does to the fact, wherever the fact is by then. A shared
 * fact is written only from a project the caller's person shares, as their choice stands inside
 * the unit. A fact that is no longer live, or whose content changed under a correction, fails the
 * call for the caller to send again. Returns whether the content changed.
 */
export async function onFact(
  ports: Pick<CorePorts, "store" | "ids" | "embedder">,
  ctx: Pick<CallContext, "caller" | "session">,
  write: { before: LiveFact; correction: Correction | null; at: Date },
  also: (unit: UnitWrites, fact: LiveFact) => Promise<void> = () => Promise.resolve(),
): Promise<boolean> {
  const { before, correction, at } = write;
  const who = { caller: ctx.caller, project: before.project, at };
  return asPerson(ports, who, async (place) => {
    const held = await holderOfFact(place, before.id);
    const fact = held?.fact ?? null;
    const stale = correction !== null && fact?.contentHash !== before.contentHash;
    if (held === null || !isLive(fact) || stale) throw changedMeanwhile(before.id);
    requireSharing(place, held.writes, `Fact ${fact.id}`);
    const changes = correction !== null && correction.content.contentHash !== fact.contentHash;
    const writes = changes
      ? await correctWhereItBelongs(ports, place, ctx, { writes: held.writes, fact }, correction)
      : held.writes;
    await also(writes, fact);
    return changes;
  });
}
