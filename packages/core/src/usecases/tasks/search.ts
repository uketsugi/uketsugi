import type {
  SearchTasksInput,
  SearchTasksResult,
  TaskEvent,
  TaskNote as NoteView,
} from "@uketsugi/contracts";
import type { Task, TaskNote, TaskState } from "../../domain.ts";
import { inPickUpOrder, leaseStanding } from "../../tasks/lease.ts";
import { historyView, NO_TASKS, noteView, taskView, type Viewer } from "../../tasks/views.ts";
import { idOf, scopeOf, type CallContext, type Outcome } from "../../context.ts";
import { notFound } from "../../failure.ts";
import type { CorePorts } from "../../ports.ts";
import { viewerOf, type Reader } from "./shared.ts";

type ReadPorts = Pick<CorePorts, "store" | "clock">;

/** The most unfinished tasks a listing reads before it orders them. */
const READ_LIMIT = 500;

/**
 * The stored states a filter can be found in. A lease that ran out is stored as `claimed` and
 * shown as `open`, so both filters read the claimed tasks and the clock decides. What was handed
 * off is open too, as the brief lists it: it can be claimed as an open task can.
 */
const STORED: Record<TaskState | "unfinished", readonly TaskState[]> = {
  unfinished: ["open", "claimed", "handed_off"],
  open: ["open", "claimed", "handed_off"],
  claimed: ["claimed"],
  handed_off: ["handed_off"],
  done: ["done"],
};

/** What a listing asks for: in one project or in every project its reader sees, at most `limit` tasks. */
interface TaskFilter {
  readonly project?: string;
  /** Only tasks shown in this state; absent means every task that is not done. */
  readonly status?: TaskState;
  /** Only tasks the reader published or holds. */
  readonly mine?: boolean;
  readonly limit: number;
}

/** A task as a listing shows it: with its newest note, if it has one. */
interface Listed {
  readonly task: Task;
  readonly note: TaskNote | null;
}

/** The tasks a listing matches, in the order a caller could pick them up, and how many there are. */
async function matching(
  ports: ReadPorts,
  reader: Reader,
  filter: TaskFilter,
  now: Date,
): Promise<{ tasks: Task[]; matched: number }> {
  const query = {
    project: filter.project,
    states: STORED[filter.status ?? "unfinished"],
    person: filter.mine === true ? reader.caller.principalId : undefined,
  };
  const scope = scopeOf(reader.caller);
  const read = await ports.store.tasks.list(scope, { ...query, limit: READ_LIMIT });
  const wanted = filter.status;
  const matches = (task: Task, status: TaskState): boolean => {
    const standing = leaseStanding(task, now);
    if (status === "open")
      return standing === "lapsed" || standing === "open" || standing === "handed_off";
    return standing === status;
  };
  const tasks = wanted === undefined ? read : read.filter((task) => matches(task, wanted));
  // Past the read limit only the store can count, and it cannot tell a lapsed lease from a live one.
  const beyond = read.length === READ_LIMIT ? await ports.store.tasks.count(scope, query) : 0;
  return { tasks: inPickUpOrder(tasks, now), matched: Math.max(tasks.length, beyond) };
}

/**
 * A listing as an agent and a person on the dashboard both read it: the tasks the reader can see
 * that match, ordered by what a caller could pick up (what was handed over, then what a lapsed
 * lease left, then open work oldest first, then what is held), each with its newest note, and
 * what views of them are drawn for. Reading takes nothing: a task stays listed until it is done.
 */
export async function readTasks(
  ports: ReadPorts,
  reader: Reader,
  filter: TaskFilter,
): Promise<{ matched: number; listed: Listed[]; viewer: Viewer }> {
  const now = ports.clock.now();
  const { tasks, matched } = await matching(ports, reader, filter, now);
  const shown = tasks.slice(0, filter.limit);
  const notes = await ports.store.tasks.latestNotes(
    scopeOf(reader.caller),
    shown.map((task) => task.id),
  );
  const viewer = await viewerOf(ports, reader, now, { tasks: shown, notes });
  const noteOf = new Map(notes.map((note) => [note.taskId, note]));
  return {
    matched,
    listed: shown.map((task) => ({ task, note: noteOf.get(task.id) ?? null })),
    viewer,
  };
}

/**
 * One task's notes and its history as its reader may see them, oldest first, with its newest note
 * and what a view of the task is drawn for.
 */
export async function readTask(
  ports: ReadPorts,
  reader: Reader,
  task: Task,
): Promise<{ note: TaskNote | null; notes: NoteView[]; history: TaskEvent[]; viewer: Viewer }> {
  const scope = scopeOf(reader.caller);
  const now = ports.clock.now();
  const [notes, steps] = await Promise.all([
    ports.store.tasks.notes(scope, [task.id]),
    ports.store.tasks.history(scope, task.id),
  ]);
  const viewer = await viewerOf(ports, reader, now, { tasks: [task], notes, steps });
  return {
    note: notes.at(-1) ?? null,
    notes: notes.map((note) => noteView(note, viewer)),
    history: historyView(steps, viewer),
    viewer,
  };
}

/** One task of the call's project with all its notes and its history, by id. */
async function byId(
  ports: CorePorts,
  ctx: CallContext,
  id: string,
): Promise<Outcome<SearchTasksResult>> {
  const task = await ports.store.tasks.get(scopeOf(ctx.caller), idOf(id));
  if (task === null || task.project !== ctx.project.key) throw notFound("task", id);
  const { note, notes, history, viewer } = await readTask(ports, ctx, task);
  return { matched: 1, shown: 1, tasks: [taskView(task, note, viewer, true)], notes, history };
}

/**
 * Lists the project's tasks (flow F5) in the order the caller could pick them up, each with its
 * newest note. Without a filter the list is every task that is not done. With `id` it is one task
 * with all its notes and its history.
 */
export async function searchTasks(
  ports: CorePorts,
  ctx: CallContext,
  input: SearchTasksInput,
): Promise<Outcome<SearchTasksResult>> {
  if (input.id !== undefined && input.id.trim() !== "") return byId(ports, ctx, input.id);
  const { status, mine, limit } = input;
  const filter = { project: ctx.project.key, status, mine, limit };
  const { matched, listed, viewer } = await readTasks(ports, ctx, filter);
  return {
    matched,
    shown: listed.length,
    tasks: listed.map(({ task, note }) => taskView(task, note, viewer, false)),
    ...(listed.length === 0 ? { message: NO_TASKS } : {}),
  };
}
