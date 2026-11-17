/**
 * Where a person's records live on a server with several people. Each person has a private
 * audience, and the server has one shared audience that everyone reads. A person chooses per
 * project whether to share it; until they do, it is private. In a shared project, what the person
 * publishes that nothing holds back (`heldBack`: a fact others can check, and a task that is not a
 * step of their own plan) is in the shared audience, and everything else is theirs alone. A call writes to
 * a shared record only from a project its person shares, so nothing of a person who keeps a
 * project private reaches anyone else. A host with one person has no shared audience: nothing is
 * asked there, and everything is private.
 *
 * All of it is decided under one lock. A person's write opens its unit on their own audience
 * (`asPerson`), whose head row every write of theirs and every choice of theirs takes first; the
 * choice is read inside that unit, and the shared audience is reached from it. So where a record
 * lands, and every move of it, follows the choice as it stands at that moment, in one transaction.
 */
import type { PrivateBecause } from "@uketsugi/contracts";
import { personActor, scopeOf } from "./context.ts";
import type { Actor, Caller, ClassedCitation, Fact, Task, Treatment } from "./domain.ts";
import { citedBy } from "./facts/citations.ts";
import { isLive } from "./facts/duplicates.ts";
import { forbidden } from "./failure.ts";
import type { CorePorts } from "./ports.ts";
import type { Unit, UnitWrites } from "./store-port.ts";

/**
 * Whether the caller has anyone to share with: false on a host with one person, where nothing is
 * asked and everything is private. The one place that asks.
 */
export function canShare(caller: Caller): boolean {
  return caller.sharedAudienceId !== null;
}

/** Who can see a record the reader can see: everyone on the server, or the reader alone. */
export function audienceOf(
  reader: Caller,
  record: { readonly audienceId: string },
): "private" | "shared" {
  return record.audienceId === reader.sharedAudienceId ? "shared" : "private";
}

/** How a person treats a project, and whether that is their choice or the standing default. */
export interface Standing {
  readonly treatment: Treatment;
  /** False while the person could choose and has not: the project is private until they do. */
  readonly chosen: boolean;
}

/** What a person's stored choice for a project means. Where there is nobody to share with, nothing is to be chosen. */
export function standing(caller: Caller, choice: Treatment | null): Standing {
  if (!canShare(caller)) return { treatment: "private", chosen: true };
  return { treatment: choice ?? "private", chosen: choice !== null };
}

/**
 * How the caller's person treats a project, as a result or a page says it. Where there is nobody
 * to share with, nothing is read. A write never decides by this: it reads the choice in its unit.
 */
export async function standingOf(
  ports: Pick<CorePorts, "store">,
  caller: Caller,
  project: string,
): Promise<Standing> {
  if (!canShare(caller)) return standing(caller, null);
  return standing(
    caller,
    await ports.store.projects.choice(caller.orgId, caller.principalId, project),
  );
}

/** A person's write in one project, inside the unit that holds their lock. */
export interface Place {
  readonly caller: Caller;
  /** Who a move made in the unit is logged as: the person, or the job that acts on their facts. */
  readonly by: Actor;
  /** The instant of the write: every row it stamps carries it. */
  readonly at: Date;
  /** The project the write is in, and how the person treats it now. It cannot change before the unit ends. */
  readonly project: string;
  readonly treatment: Treatment;
  /** The unit, open on the person's own audience. */
  readonly own: Unit;
  /**
   * The shared audience's writes, whose head is locked the first time they are asked for; null
   * on a host with one person.
   */
  shared(): Promise<UnitWrites | null>;
}

/** Whose write, in which project, at what instant, and who a move it makes is logged as (the person, by default). */
export interface Who {
  readonly caller: Caller;
  readonly project: string;
  readonly at: Date;
  readonly by?: Actor;
}

/**
 * Runs a person's write in one project as one unit on their own audience, with their choice for
 * the project read inside it. Everything that decides where a record of theirs is goes through
 * here, so a write and a change of mind are always one after the other, never interleaved.
 */
export function asPerson<T>(
  ports: Pick<CorePorts, "store">,
  who: Who,
  work: (place: Place) => Promise<T>,
): Promise<T> {
  const { caller, project, at, by = personActor(who.caller) } = who;
  const target = { orgId: caller.orgId, audienceId: caller.privateAudienceId, at };
  return ports.store.unit(target, async (own) => {
    const sharedId = caller.sharedAudienceId;
    const treatment = sharedId === null ? "private" : ((await own.choice(project)) ?? "private");
    let reached: Promise<UnitWrites> | undefined;
    const shared = (): Promise<UnitWrites | null> =>
      sharedId === null ? Promise.resolve(null) : (reached ??= own.on(sharedId));
    return work({ caller, by, at, project, treatment, own, shared });
  });
}

/**
 * Whether the person shares a project, as their choice stands in the unit: the shared audience's
 * writes if so, null otherwise. The project is the write's own unless another is named.
 */
export async function sharedIfSharing(
  place: Place,
  project: string = place.project,
): Promise<UnitWrites | null> {
  if (!canShare(place.caller)) return null;
  const treatment = project === place.project ? place.treatment : await place.own.choice(project);
  return treatment === "shared" ? place.shared() : null;
}

/**
 * Where a record the caller may see is now: in their own audience, or else in the shared one,
 * whose head is taken only then. `read` finds the record in an audience's writes. Null when
 * neither holds it.
 */
async function holderOf<T>(
  place: Place,
  read: (writes: UnitWrites) => Promise<T | null>,
): Promise<{ writes: UnitWrites; record: T } | null> {
  const mine = await read(place.own);
  if (mine !== null) return { writes: place.own, record: mine };
  const shared = await place.shared();
  const theirs = shared === null ? null : await read(shared);
  return shared === null || theirs === null ? null : { writes: shared, record: theirs };
}

/** Where a fact the caller may see is now, and the writes of the audience that holds it. */
export interface HeldFact {
  readonly writes: UnitWrites;
  readonly fact: Fact;
}

export async function holderOfFact(place: Place, id: string): Promise<HeldFact | null> {
  const held = await holderOf(place, (writes) => writes.facts.get(id));
  return held === null ? null : { writes: held.writes, fact: held.record };
}

/** The same for a task. */
export async function holderOfTask(
  place: Place,
  id: string,
): Promise<{ writes: UnitWrites; task: Task } | null> {
  const held = await holderOf(place, (writes) => writes.tasks.get(id));
  return held === null ? null : { writes: held.writes, task: held.record };
}

/**
 * Runs a write on some of a person's facts in one unit under their lock, each fact found again
 * under it, where it is and as it stands by then: a move or a merge may have landed since it was
 * read. `held` has the facts either audience holds, by id. The shared head, if there is one, is
 * taken before any fact is looked for: the write may change rows that name shared facts, and a
 * unit that took that head only later could wait on another person's withdrawal while it waits
 * on this unit.
 */
export function onHeldFacts<T>(
  ports: Pick<CorePorts, "store">,
  who: Who,
  ids: readonly string[],
  work: (held: ReadonlyMap<string, HeldFact>, place: Place) => Promise<T>,
): Promise<T> {
  return asPerson(ports, who, async (place) => {
    await place.shared();
    const held = new Map<string, HeldFact>();
    for (const id of ids) {
      const found = await holderOfFact(place, id);
      if (found !== null) held.set(id, found);
    }
    return work(held, place);
  });
}

/** Which of these facts that the caller can see are the caller's own: what only their author may act on. */
export async function ownFacts(
  ports: Pick<CorePorts, "store">,
  caller: Caller,
  ids: readonly string[],
): Promise<Set<string>> {
  const facts = await ports.store.facts.getMany(scopeOf(caller), ids);
  return new Set(facts.filter((fact) => fact.author === caller.principalId).map((fact) => fact.id));
}

/**
 * What decides whether others are shown a fact: its citations, and whether a model wrote it and
 * nobody has checked it. A stored fact is one, and so is the content of a fact about to be stored.
 */
export type Cited = {
  readonly citations: readonly ClassedCitation[];
  /** The session a model wrote it from, where a model did. */
  readonly digestSession?: string | null;
  readonly status?: Fact["status"];
};

/**
 * Why a fact is kept from other people in a project its person shares:
 * - `model_unchecked`: a model wrote it from a session, and neither its person nor an agent of
 *   theirs has checked it: a model's word reaches nobody else until someone has;
 * - `no_source`: none of its citations is one anyone can open;
 * - `cites_private`: it cites a fact of its author's that others cannot see, so they could not
 *   follow it;
 * - `merged_word`: a duplicate merged into it rests on somebody's word alone, and a chain moves
 *   whole, so sharing the fact would show that duplicate too.
 */
export type HeldBack = Exclude<PrivateBecause, "project">;

function hasSource(fact: Cited): boolean {
  return fact.citations.some((entry) => entry.class === "checkable");
}

/**
 * Whether only a model has said this fact, and nobody has checked it: it was written by a model,
 * is unconfirmed, and nothing merged into it was said by a person's agent. A model cannot check
 * its own work, and the check that the record names its source ties a claim to a file, not to
 * what the claim says. The person's check (`update_fact` with `confirm`) releases it.
 */
function modelAlone(fact: Cited, behind: readonly Fact[]): boolean {
  const byModel = (one: Pick<Cited, "digestSession">): boolean =>
    (one.digestSession ?? null) !== null;
  return byModel(fact) && fact.status !== "confirmed" && behind.every(byModel);
}

/**
 * Why a fact nothing has replaced is not one other people may be shown, or null when it is: the
 * one rule of what is shared in a project its person shares, for where a fact lands, for every
 * move, and for what the dashboard tells its author. `behind` is every fact it replaced, and
 * `ownAlone` finds which of the given facts are in its author's own audience.
 *
 * Only the author's own private facts hold a fact back, and only on the fact itself: a fact it
 * replaced goes with it and nobody follows that fact's citations, and a fact another person took
 * back is flagged on those that cite it and moves none of them. So nobody else's choice decides
 * where a person's fact is.
 */
export async function heldBack(
  fact: Cited,
  behind: readonly Fact[],
  ownAlone: (ids: readonly string[]) => Promise<readonly Fact[]>,
): Promise<HeldBack | null> {
  if (modelAlone(fact, behind)) return "model_unchecked";
  if (!hasSource(fact)) return "no_source";
  const within = new Set(behind.map((member) => member.id));
  const cited = citedBy(fact.citations).filter((id) => !within.has(id));
  if (cited.length > 0 && (await ownAlone(cited)).length > 0) return "cites_private";
  return behind.every((member) => member.claim === null || hasSource(member))
    ? null
    : "merged_word";
}

/**
 * Why a fact is the reader's alone, as a page or a result tells them: read outside any unit, by
 * the rule that placed it. Null for a fact others see, one something has replaced (it goes where
 * the fact that replaced it goes), and on a host with one person, where nothing is asked.
 */
export async function privateBecause(
  ports: Pick<CorePorts, "store">,
  reader: Caller,
  fact: Fact,
): Promise<PrivateBecause | null> {
  const alone = fact.audienceId === reader.privateAudienceId;
  if (!canShare(reader) || !alone || !isLive(fact)) return null;
  if ((await standingOf(ports, reader, fact.project)).treatment !== "shared") return "project";
  const { facts } = ports.store;
  const mine = { orgId: reader.orgId, audienceIds: [reader.privateAudienceId] };
  return heldBack(fact, await facts.behind(mine, fact.id), (ids) => facts.getMany(mine, ids));
}

/**
 * Who can see a fact, as a result that stores or shows it says on a server with several people:
 * a project's treatment says what its person shares there, not where one fact is. Nothing on a
 * host with one person.
 */
export async function seenBy(
  ports: Pick<CorePorts, "store">,
  reader: Caller,
  id: string,
): Promise<{ audience?: "private" | "shared"; private_because?: PrivateBecause }> {
  if (!canShare(reader)) return {};
  const fact = await ports.store.facts.get(scopeOf(reader), id);
  if (fact === null) return {};
  if (audienceOf(reader, fact) === "shared") return { audience: "shared" };
  const because = await privateBecause(ports, reader, fact);
  return { audience: "private", ...(because === null ? {} : { private_because: because }) };
}

/** Where a new task lands. A step of an agent's own plan is always the person's alone. */
export async function taskLanding(place: Place, tracked: boolean): Promise<UnitWrites> {
  return (tracked ? null : await sharedIfSharing(place)) ?? place.own;
}

/**
 * Refuses a call that would write to a shared record from a project its person keeps private. A
 * confirmation, a flag, a claim and a note are all text or a name that everyone would see.
 */
export function requireSharing(place: Place, writes: UnitWrites, record: string): void {
  if (writes === place.own || place.treatment === "shared") return;
  throw forbidden(
    `${record} is shared with everyone on this server, and this project is private for your person.`,
    "Read it freely. To confirm, flag, claim or note what others shared here, your person first shares the project on the dashboard's Projects page; an agent cannot make that choice.",
  );
}
