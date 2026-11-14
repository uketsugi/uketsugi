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
import type { Caller, Fact } from "../domain.ts";
import { isLive } from "../facts/duplicates.ts";
import { invalidInput, unsupported } from "../failure.ts";
import type { CorePorts } from "../ports.ts";
import { isPersonal, parseProject, resolveProject } from "../project.ts";
import { asPerson, heldBack, type Place } from "../sharing.ts";
import type { UnitWrites } from "../store-port.ts";
import { share, withdraw } from "./facts/place.ts";

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
  const back = await withdraw(ports, place, shared, {
    facts: sharing ? await heads(out, true) : out.map((chain) => chain.head),
    tasks: tasks.out.filter((task) => !sharing || task.tracked),
  });
  if (!sharing) return back;
  const home = chainsOf(await place.own.facts.writtenBy(person, project));
  const gone = await share(ports, place, shared, {
    facts: await heads(home, false),
    tasks: tasks.home.filter((task) => !task.tracked),
  });
  return { facts: back.facts + gone.facts, tasks: back.tasks + gone.tasks };
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
  const ref = parseProject(input.project);
  const project = ref === null ? null : await resolveProject(ports, caller, ref);
  if (project === null) {
    throw invalidInput(
      `"${input.project}" does not name a project.`,
      "Choose one of your projects from the list.",
    );
  }
  if (caller.sharedAudienceId === null) {
    throw unsupported(
      "This server has one person, so there is nobody to share a project with.",
      "Whoever runs the server adds a person with `ukt invite <name>`; projects can be shared from then on.",
    );
  }
  const { treatment } = input;
  if (treatment === "shared" && isPersonal(project)) {
    throw unsupported(
      `${project.key} is a named project of your own, and its name is each person's own.`,
      "Share a repository's project; a named project stays private.",
    );
  }
  const who = { caller, project: project.key, at: ports.clock.now() };
  const moved = await asPerson(ports, who, async (place) => {
    const shared = await place.shared();
    if (shared === null) return { facts: 0, tasks: 0 };
    await place.own.choose(project.key, treatment);
    return reconcile(ports, { ...place, treatment }, shared, project.key);
  });
  return { project: project.key, treatment, moved };
}
