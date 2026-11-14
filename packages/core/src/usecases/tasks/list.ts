/**
 * Tasks as the dashboard reads them: the list an agent's `search_tasks` gives, over every project
 * the person can see or one of them, and one task with its notes and its history. Every read
 * takes the person's visible set, so a task shows here exactly when the sharing rules let the
 * person see it. A person on the dashboard is in no session: nothing is stamped or counted.
 */
import type { TaskDetail, TaskListParams, TaskPage } from "@uketsugi/contracts";
import { idOf, scopeOf } from "../../context.ts";
import type { Caller } from "../../domain.ts";
import { notFound } from "../../failure.ts";
import type { CorePorts } from "../../ports.ts";
import { projectFilter } from "../../project.ts";
import { apiTask } from "../../tasks/views.ts";
import { readTask, readTasks } from "./search.ts";

type ReadPorts = Pick<CorePorts, "store" | "clock">;

/** The tasks the person can see, in the order an agent could pick them up. */
export async function listTasks(
  ports: ReadPorts,
  caller: Caller,
  params: TaskListParams,
): Promise<TaskPage> {
  const { status, limit } = params;
  const filter = { project: projectFilter(params.project, "tasks"), status, limit };
  const { matched, listed, viewer } = await readTasks(ports, { caller }, filter);
  const { sharedAudienceId } = caller;
  return {
    tasks: listed.map(({ task, note }) =>
      apiTask(task, note, viewer, { sharedAudienceId, whole: false }),
    ),
    matched,
  };
}

/** One task, whole, with every note and its history, oldest first. */
export async function taskDetail(
  ports: ReadPorts,
  caller: Caller,
  id: string,
): Promise<TaskDetail> {
  const task = await ports.store.tasks.get(scopeOf(caller), idOf(id));
  if (task === null) throw notFound("listed task", id);
  const { note, notes, history, viewer } = await readTask(ports, { caller }, task);
  const { sharedAudienceId } = caller;
  return { task: apiTask(task, note, viewer, { sharedAudienceId, whole: true }), notes, history };
}
