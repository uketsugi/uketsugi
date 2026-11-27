/**
 * Where a person's records live on a server with several people. Each person has a private
 * audience, and belongs to groups, each an audience its members read. A person chooses per
 * project whether to share it, and with which group; until they do, it is private. In a shared
 * project, what the person publishes that nothing holds back (`heldBack`: a fact others can
 * check, and a task that is not a step of their own plan) is in the group's audience, and
 * everything else is theirs alone. A call writes to a record of a group only from a project its
 * person shares with that group, so nothing of a person who keeps a project private reaches
 * anyone else. A host with one person has no group: nothing is asked there, and everything is
 * private.
 *
 * All of it is decided under one lock. A person's write opens its unit on their own audience
 * (`asPerson`), whose head row every write of theirs and every choice of theirs takes first; the
 * choice is read inside that unit, and the group is reached from it. So where a record lands,
 * and every move of it, follows the choice as it stands at that moment, in one transaction.
 */
import type { PrivateBecause } from "@uketsugi/contracts";
import { personActor, scopeOf } from "./context.ts";
import {
  EVERYONE,
  type Actor,
  type Caller,
  type Choice,
  type ClassedCitation,
  type Fact,
  type Group,
  type Task,
  type Treatment,
} from "./domain.ts";
import { citedBy } from "./facts/citations.ts";
import { isLive } from "./facts/duplicates.ts";
import { forbidden, unsupported } from "./failure.ts";
import type { CorePorts } from "./ports.ts";
import type { Unit, UnitWrites } from "./store-port.ts";

/**
 * Whether the caller has anyone to share with: false on a host with one person, where nothing is
 * asked and everything is private. The one place that asks.
 */
export function canShare(caller: Caller): boolean {
  return caller.groups.length > 0;
}

/** The group of the reader that holds a record the reader can see; none for their own. */
export function groupOf(reader: Caller, record: { readonly audienceId: string }): Group | null {
  return reader.groups.find((group) => group.id === record.audienceId) ?? null;
}

/** Who can see a record the reader can see: a group of theirs, or the reader alone. */
export function audienceOf(
  reader: Caller,
  record: { readonly audienceId: string },
): "private" | "shared" {
  return groupOf(reader, record) === null ? "private" : "shared";
}

/** How a person treats a project, and whether that is their choice or the standing default. */
export interface Standing {
  readonly treatment: Treatment;
  /** The group the project is shared with: set exactly when `treatment` is `shared`. */
  readonly group: Group | null;
  /** False while the person could choose and has not: the project is private until they do. */
  readonly chosen: boolean;
}

/** What a person's stored choice for a project means. Where there is nobody to share with, nothing is to be chosen. */
export function standing(caller: Caller, choice: Choice | null): Standing {
  if (!canShare(caller)) return { treatment: "private", group: null, chosen: true };
  // A choice of a group the person has left is no longer one: the project is private again.
  const group = caller.groups.find((member) => member.id === choice?.groupId) ?? null;
  return { treatment: group === null ? "private" : "shared", group, chosen: choice !== null };
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
  /** The group the person shares the project with, as their choice stands in the unit; null when it is private. */
  readonly group: Group | null;
  /** The unit, open on the person's own audience. */
  readonly own: Unit;
  /**
   * The writes of the group the project is shared with, whose head is locked the first time they
   * are asked for; null while the project is private.
   */
  shared(): Promise<UnitWrites | null>;
  /**
   * The writes of a group of the person's, whose head is locked the first time. Heads are taken
   * in the order of the groups' ids, which is how no two units wait for each other's.
   */
  reach(groupId: string): Promise<UnitWrites>;
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
    const { group, treatment } = standing(
      caller,
      canShare(caller) ? await own.choice(project) : null,
    );
    const reached = new Map<string, Promise<UnitWrites>>();
    const reach = (groupId: string): Promise<UnitWrites> => {
      if (!caller.groups.some((member) => member.id === groupId))
        return Promise.reject(new Error("a unit reaches only the groups of its person"));
      const held = reached.get(groupId);
      if (held !== undefined) return held;
      // Heads are taken in the order of the groups' ids; what a call needs is therefore reached
      // together, first (`holdFacts`), and a group asked for later than a larger one is refused.
      if ([...reached.keys()].some((taken) => taken > groupId)) {
        return Promise.reject(
          unsupported(
            "This call would write into two of your groups at once, in an order the server cannot take.",
            "Share the project that holds the fact you cite with the same group, or cite a fact of the group this project is shared with.",
          ),
        );
      }
      const writes = own.on(groupId);
      reached.set(groupId, writes);
      return writes;
    };
    const shared = (): Promise<UnitWrites | null> =>
      group === null ? Promise.resolve(null) : reach(group.id);
    return work({ caller, by, at, project, treatment, group, own, shared, reach });
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
  if (project === place.project) return place.treatment === "shared" ? place.shared() : null;
  const { group } = standing(place.caller, await place.own.choice(project));
  return group === null ? null : place.reach(group.id);
}

/**
 * Takes the heads of all of the person's groups, in the order of their ids, and returns their
 * writes in that order. What a move changes the place of can be a fact of another project, in
 * another group of theirs, so a unit that may move records has them all before it reads any.
 */
export async function reachAll(place: Place): Promise<UnitWrites[]> {
  const found: UnitWrites[] = [];
  for (const group of [...place.caller.groups].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    found.push(await place.reach(group.id));
  }
  return found;
}

/**
 * Takes the heads of every group a write needs before it reads anything: the group its project is
 * shared with and the group that holds each fact it names, in the order of the groups' ids, which
 * is the order the store needs. A write that cites a fact of another group of the person's then
 * succeeds whichever group has the smaller id.
 */
export async function holdFacts(place: Place, ids: readonly string[]): Promise<void> {
  if (!canShare(place.caller)) return;
  const wanted = new Set<string>(place.group === null ? [] : [place.group.id]);
  for (const id of ids) {
    const held = await place.own.audienceOf("fact", id);
    if (held !== null && held !== place.own.audienceId) wanted.add(held);
  }
  for (const group of [...wanted].sort()) await place.reach(group);
}

/**
 * Where a record the caller may see is now: in their own audience, or else in the group that
 * holds it, whose head is taken only then. `read` finds the record in an audience's writes. Null
 * when neither holds it.
 */
async function holderOf<T>(
  place: Place,
  kind: "fact" | "task",
  id: string,
  read: (writes: UnitWrites) => Promise<T | null>,
): Promise<{ writes: UnitWrites; record: T } | null> {
  const mine = await read(place.own);
  if (mine !== null) return { writes: place.own, record: mine };
  const audienceId = await place.own.audienceOf(kind, id);
  if (audienceId === null || audienceId === place.own.audienceId) return null;
  const writes = await place.reach(audienceId);
  const theirs = await read(writes);
  return theirs === null ? null : { writes, record: theirs };
}

/** Where a fact the caller may see is now, and the writes of the audience that holds it. */
export interface HeldFact {
  readonly writes: UnitWrites;
  readonly fact: Fact;
}

export async function holderOfFact(place: Place, id: string): Promise<HeldFact | null> {
  const held = await holderOf(place, "fact", id, (writes) => writes.facts.get(id));
  return held === null ? null : { writes: held.writes, fact: held.record };
}

/** The same for a task. */
export async function holderOfTask(
  place: Place,
  id: string,
): Promise<{ writes: UnitWrites; task: Task } | null> {
  const held = await holderOf(place, "task", id, (writes) => writes.tasks.get(id));
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
    await reachAll(place);
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
): Promise<{
  audience?: "private" | "shared";
  group?: string;
  private_because?: PrivateBecause;
}> {
  if (!canShare(reader)) return {};
  const fact = await ports.store.facts.get(scopeOf(reader), id);
  if (fact === null) return {};
  const group = groupOf(reader, fact);
  // `everyone` is the group a server always had, and is not named.
  if (group !== null) return { audience: "shared", ...namedGroup(group) };
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
  if (writes === place.own || writes.audienceId === place.group?.id) return;
  const holder = place.caller.groups.find((group) => group.id === writes.audienceId);
  const sharedWith = place.group === null ? null : sharedWithWords(place.group);
  throw forbidden(
    `${record} is shared with ${holder === undefined ? "others" : sharedWithWords(holder)}, and this project is ${sharedWith === null ? "private for your person" : `shared with ${sharedWith}, not with them`}.`,
    `Read it freely. To confirm, flag, claim or note what others shared here, your person first shares the project${place.group === null || holder === undefined ? "" : ` with ${sharedWithWords(holder)}`} on the dashboard's Projects page; an agent cannot make that choice.`,
  );
}

/** The name a result or a page gives a group: none for `everyone`, which is what a server always said. */
export function namedGroup(group: Group | null): { group?: string } {
  return group === null || group.name === EVERYONE ? {} : { group: group.name };
}

/** Who a group is, as a sentence says it: `everyone` is what a server with one shared audience always said. */
export function sharedWithWords(group: Group): string {
  return group.name === EVERYONE ? "everyone on this server" : `the group ${group.name}`;
}
