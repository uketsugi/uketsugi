/**
 * A person joins one of their projects into another, usually because a repository was renamed or
 * moved, or a folder was pushed for the first time: its key changed and the new one starts empty,
 * while the memory is stored under the old. Everything of theirs in the first becomes the
 * second's in one unit, and the first is their other name for the second, so that an old clone or
 * another machine that still names it lands there. The second may be a key nothing has used yet.
 * Names never chain: what meant the first now means the second. Duplicate facts across the two
 * are not merged.
 *
 * On a server with other people it is refused while the shared audience holds any record of the
 * first, whoever wrote it, since a name of one person's cannot bring those along. A join is not
 * undone.
 */
import type { ProjectJoin, ProjectJoined } from "@uketsugi/contracts";
import type { Caller } from "../domain.ts";
import { invalidInput, ToolFailure } from "../failure.ts";
import type { CorePorts } from "../ports.ts";
import { ownProject, parseProject, resolveProject } from "../project.ts";
import { asPerson } from "../sharing.ts";

type Ports = Pick<CorePorts, "store" | "clock" | "ids" | "embedder">;

export async function joinProjects(
  ports: Ports,
  caller: Caller,
  params: ProjectJoin,
): Promise<ProjectJoined> {
  const from = await ownProject(ports, caller, params.from);
  const ref = parseProject(params.into);
  if (ref === null) {
    throw invalidInput(
      `"${params.into}" does not name a project.`,
      "Name the project as its repository's origin, host/owner/name, or as one of your own projects.",
    );
  }
  const into = await resolveProject(ports, caller, ref);
  if (into === null) {
    throw invalidInput(
      `"${params.into}" is not a project of yours.`,
      "Name a repository's origin, or a named project you made.",
    );
  }
  if (into.key === from) {
    throw invalidInput(
      `${from} cannot be joined into itself.`,
      "Choose a different project to join it into.",
    );
  }
  const who = { caller, project: from, at: ports.clock.now() };
  const joined = await asPerson(ports, who, (place) => place.own.joinProject(from, into.key));
  if ("shared" in joined) {
    throw new ToolFailure("conflict", {
      what: `${from} holds ${joined.shared} shared ${joined.shared === 1 ? "record" : "records"} that others on this server read.`,
      meaning:
        "Nothing was joined and the project is as it was: a join cannot move what other people read.",
      next: "If the shared records are yours, keep the project private first, which takes them back. Joining a project that other people share is not possible yet.",
    });
  }
  return { from, into: into.key, ...joined };
}
