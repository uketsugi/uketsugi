/**
 * A person's choice for a project, and what it moves. Sharing a project moves what the person
 * already published there that nothing holds back (`heldBack` in `sharing.ts`, and tasks that are
 * not steps of a plan) from their own audience to the shared one; keeping it private moves
 * everything of theirs in the project back. The choice and
 * the moves are one unit under the person's lock: either both are done or neither is. What other
 * people did to a record that goes back goes with it, except their confirmations: a fact nobody
 * else can see is confirmed by nobody else. The choice is a person's: no tool makes it.
 */
import type { ProjectChoice, ProjectChoiceRequest } from "@uketsugi/contracts";
import { EVERYONE, type Caller, type Fact, type Group } from "../domain.ts";
import { isLive } from "../facts/duplicates.ts";
import { invalidInput, ToolFailure, unsupported } from "../failure.ts";
import type { CorePorts } from "../ports.ts";
import { isPersonal, projectNamed } from "../project.ts";
import { asPerson, canShare, heldBack, namedGroup, reachAll, type Place } from "../sharing.ts";
import type { UnitWrites } from "../store-port.ts";
import { move } from "./facts/place.ts";

type MovePorts = Pick<CorePorts, "store" | "clock" | "ids" | "embedder">;

/** A chain of one person's facts: the fact nothing has replaced, and every fact it replaced. */
interface Chain {
  readonly head: Fact;
  readonly behind: readonly Fact[];
}

/** The chains among one person's facts in a project, as one audience holds them. */
function chainsOf(facts: readonly Fact[]): Chain[] {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const headOf = (fact: Fact): Fact => {
    let at = fact;
    for (let step = 0; step < facts.length; step += 1) {
      const next = at.supersededBy === null ? undefined : byId.get(at.supersededBy);
      if (next === undefined) break;
      at = next;
    }
    return at;
  };
  const members = Map.groupBy(facts, (fact) => headOf(fact));
  return [...members].map(([head, chain]) => ({
    head,
    behind: chain.filter((fact) => fact !== head),
  }));
}

/**
 * Makes the person's records in a project be where their choice says, inside their unit: what
 * nothing holds back in the shared audience when they share it, and everything theirs alone
 * otherwise. It moves only what is not yet where it belongs, so it can run again at any time.
 * Each chain is judged as it stands; one that only a citation of another held back follows that
 * one when it moves (`share`), in whichever of the person's projects it is.
 */
async function reconcile(
  ports: MovePorts,
  place: Place,
  shared: UnitWrites,
  project: string,
): Promise<ProjectChoice["moved"]> {
  const person = place.caller.principalId;
  const sharing = place.treatment === "shared";
  const ownAlone = (ids: readonly string[]) => place.own.facts.getMany(ids);
  /** The live facts at the head of the chains that are, or are not, held back. */
  const heads = async (chains: readonly Chain[], held: boolean): Promise<Fact[]> => {
    const found: Fact[] = [];
    for (const { head, behind } of chains.filter((chain) => isLive(chain.head))) {
      if (((await heldBack(head, behind, ownAlone)) !== null) === held) found.push(head);
    }
    return found;
  };
  const out = chainsOf(await shared.facts.writtenBy(person, project));
  const tasks = {
    home: await place.own.tasks.publishedBy(person, project),
    out: await shared.tasks.publishedBy(person, project),
  };
  // A redacted fact stays where it was redacted while the project is shared: those who cited it
  // still open its stub.
  const back = await move(
    ports,
    place,
    shared,
    {
      facts: sharing ? await heads(out, true) : out.map((chain) => chain.head),
      tasks: tasks.out.filter((task) => !sharing || task.tracked),
    },
    "withdrawn",
  );
  if (!sharing) return back;
  const home = chainsOf(await place.own.facts.writtenBy(person, project));
  const gone = await move(
    ports,
    place,
    shared,
    {
      facts: await heads(home, false),
      tasks: tasks.home.filter((task) => !task.tracked),
    },
    "shared",
  );
  return { facts: back.facts + gone.facts, tasks: back.tasks + gone.tasks };
}

/** Brings everything the person shared in a project home to their own audience, as keeping it private does. */
export async function bringHome(ports: MovePorts, place: Place, project: string): Promise<void> {
  const shared = await place.shared();
  if (shared !== null) {
    await reconcile(ports, { ...place, treatment: "private", group: null }, shared, project);
  }
}

/**
 * Records a person's choice for a project and moves their records to match it, in one unit: a
 * choice whose moves fail is not recorded. Choosing what is already chosen moves whatever is not
 * yet where it belongs.
 */
export async function chooseTreatment(
  ports: MovePorts,
  caller: Caller,
  input: ProjectChoiceRequest,
): Promise<ProjectChoice> {
  const project = await projectNamed(ports, caller, input.project);
  if (project === null) {
    throw invalidInput(
      `"${input.project}" does not name a project.`,
      "Choose one of your projects from the list.",
    );
  }
  if (!canShare(caller)) {
    throw unsupported(
      "This server has one person, so there is nobody to share a project with.",
      "Whoever runs the server adds a person with `ukt invite <name>`; projects can be shared from then on.",
    );
  }
  const { treatment } = input;
  if (treatment === "shared" && isPersonal(project)) {
    throw unsupported(
      `${project.key} is a ${project.kind} project of your own, and its name is each person's own.`,
      "Share a repository's project; a named project or a folder's stays private.",
    );
  }
  const group = treatment === "shared" ? groupNamed(caller, input.group) : null;
  const who = { caller, project: project.key, at: ports.clock.now() };
  const moved = await asPerson(ports, who, async (place) => {
    if (group !== null && place.group !== null && place.group.id !== group.id) {
      throw new ToolFailure("conflict", {
        what: `${project.key} is shared with ${place.group.name}.`,
        meaning: "Nothing was changed: a project is shared with one group at a time.",
        next: `Keep it private first, which takes back what you shared, and then share it with ${group.name}.`,
      });
    }
    // What follows a move can land in the group of another project of the person's: every group of
    // theirs is taken first, in the order of their ids, so a share succeeds whichever has the smaller.
    await reachAll(place);
    await place.own.choose(project.key, group?.id ?? null);
    // Where the records are now, or are to go: the group they are shared with, or were.
    const shared = group === null ? await place.shared() : await place.reach(group.id);
    if (shared === null) return { facts: 0, tasks: 0 };
    // The unit now reaches the group the choice names, for the moves and for what follows them.
    const chosen = { ...place, treatment, group, shared: () => Promise.resolve(shared) };
    return reconcile(ports, chosen, shared, project.key);
  });
  return { project: project.key, treatment, ...namedGroup(group), moved };
}

/** The group of the caller's a request names; `everyone` when it names none. */
function groupNamed(caller: Caller, name: string | undefined): Group {
  const wanted = (name ?? EVERYONE).trim();
  const found = caller.groups.find((group) => group.name === wanted);
  if (found === undefined) {
    throw invalidInput(
      `You are not in a group called "${wanted}".`,
      `Choose one of your groups: ${caller.groups.map((group) => group.name).join(", ")}.`,
    );
  }
  return found;
}
