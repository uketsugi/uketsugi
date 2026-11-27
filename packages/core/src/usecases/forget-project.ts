/**
 * A person deletes a project of theirs, with everything they hold in it, and is first shown what
 * that is. What is theirs: the facts their agents published there, the tasks their agents
 * published, their sessions with their notes, and their choice for the project. Another person's
 * facts and tasks in the same project are not theirs to delete and stay, as does what the person
 * wrote on those (a confirmation, a note on a task): it stays with the record it is on, as it
 * does when a project is taken back from sharing.
 *
 * It is one unit under the person's lock. What they shared is first brought home by the moves a
 * change of mind makes (`bringHome`), so other people's facts that cite one are flagged as they
 * would be for a withdrawal; then everything of the project in the person's own audience is
 * deleted, with what any log holds about it. The person's own facts that cited a deleted one are
 * flagged first.
 */
import type { ProjectContents, ProjectDeleted, ProjectNamed } from "@uketsugi/contracts";
import { scopeOf } from "../context.ts";
import type { Caller } from "../domain.ts";
import type { CorePorts } from "../ports.ts";
import { ownProject } from "../project.ts";
import { asPerson } from "../sharing.ts";
import { flagCiting } from "./facts/write.ts";
import { bringHome } from "./sharing.ts";

type Ports = Pick<CorePorts, "store" | "clock" | "ids" | "embedder">;

/** What the person holds in a project, which is what deleting it takes, and what of other people's stays. */
export async function projectContents(
  ports: Ports,
  caller: Caller,
  params: ProjectNamed,
): Promise<ProjectContents> {
  const project = await ownProject(ports, caller, params.project);
  const held = await ports.store.projects.holdings(scopeOf(caller), caller.principalId, project);
  const { othersFacts, othersTasks, ...mine } = held;
  return { project, ...mine, others_facts: othersFacts, others_tasks: othersTasks };
}

/** Deletes what the person holds in the project, as `projectContents` showed it. */
export async function deleteProject(
  ports: Ports,
  caller: Caller,
  params: ProjectNamed,
): Promise<ProjectDeleted> {
  const project = await ownProject(ports, caller, params.project);
  const who = { caller, project, at: ports.clock.now() };
  const gone = await asPerson(ports, who, async (place) => {
    await bringHome(ports, place, project);
    for (const fact of await place.own.facts.writtenBy(caller.principalId, project)) {
      await flagCiting(ports, place.own, null, fact.id);
    }
    return place.own.forgetProject(project);
  });
  return { project, ...gone };
}
