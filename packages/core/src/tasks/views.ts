/**
 * Tasks as a result carries them and as the agent reads them: records in, the contract's shapes
 * and the result's text out. Nothing here reads a store. A task's text is data for the reader,
 * never an instruction.
 */
import type {
  ApiTask,
  ClaimTaskResult,
  PublishTaskResult,
  SearchTasksResult,
  TaskEvent,
  TaskNote as NoteView,
  Task as TaskView,
  UpdateTaskResult,
} from "@uketsugi/contracts";
import { nameOf } from "../context.ts";
import type { Caller, Session, Task, TaskLease, TaskNote } from "../domain.ts";
import { footer, headOf } from "../render.ts";
import { audienceOf } from "../sharing.ts";
import type { TaskStep } from "../store-port.ts";
import { leaseStanding } from "./lease.ts";

/** How much of a note a list shows. One task by id, and a claim, show every note whole. */
const NOTE_EXCERPT_CHARS = 400;

/** The reply to a listing that shows no task. */
export const NO_TASKS = "no tasks match in this project";

/** What a view is drawn for: the instant, the caller's session, and the people and sessions named. */
export interface Viewer {
  readonly now: Date;
  /**
   * The caller's inferred session: a lease taken in it is marked, as a hint and nothing more. Null
   * for a reader who is in no session: a person on the dashboard.
   */
  readonly sessionId: string | null;
  /** Display names by principal id. */
  readonly names: ReadonlyMap<string, string>;
  /** The sessions a lease, a note or a step was made in, by id: where each reads its client's name. */
  readonly sessions: ReadonlyMap<string, Session>;
}

/** The name of the client a session ran in, when the session is known. */
function clientOf(viewer: Viewer, session: string | null): string | undefined {
  return session === null ? undefined : viewer.sessions.get(session)?.clientName;
}

function leaseFields(lease: TaskLease, lapsed: boolean, viewer: Viewer): Partial<TaskView> {
  return {
    holder: nameOf(viewer.names, lease.holder),
    holder_client: clientOf(viewer, lease.session),
    ...(lease.session === viewer.sessionId ? { held_by_this_session: true } : {}),
    lease_expires_at: lease.expiresAt.toISOString(),
    ...(lapsed ? { lapsed: true } : {}),
  };
}

function noteFields(note: TaskNote, whole: boolean, viewer: Viewer): Partial<TaskView> {
  return {
    note: whole ? note.text : headOf(note.text, NOTE_EXCERPT_CHARS),
    note_kind: note.kind,
    note_by: nameOf(viewer.names, note.author),
    note_client: clientOf(viewer, note.session),
    note_at: note.at.toISOString(),
  };
}

/**
 * A task as a result carries it, with its newest note. A lease that ran out shows as `open` and
 * `lapsed`, with who held it. `whole` adds the description and the note's full text.
 */
export function taskView(
  task: Task,
  note: TaskNote | null,
  viewer: Viewer,
  whole: boolean,
): TaskView {
  const standing = leaseStanding(task, viewer.now);
  return {
    id: task.id,
    title: task.title,
    ...(whole && task.description !== null ? { description: task.description } : {}),
    state: standing === "lapsed" ? "open" : standing,
    version: task.version,
    ...(task.tracked ? { tracked: true } : {}),
    publisher: nameOf(viewer.names, task.publisher),
    ...(task.lease === null ? {} : leaseFields(task.lease, standing === "lapsed", viewer)),
    ...(note === null ? {} : noteFields(note, whole, viewer)),
    updated_at: task.updatedAt.toISOString(),
  };
}

/**
 * A task as the dashboard shows it to its reader: the same view, with its project, when it was
 * published and who can see it.
 */
export function apiTask(
  task: Task,
  note: TaskNote | null,
  viewer: Viewer,
  shown: { readonly reader: Caller; readonly whole: boolean },
): ApiTask {
  return {
    ...taskView(task, note, viewer, shown.whole),
    project: task.project,
    audience: audienceOf(shown.reader, task),
    created_at: task.createdAt.toISOString(),
  };
}

export function noteView(note: TaskNote, viewer: Viewer): NoteView {
  return {
    kind: note.kind,
    text: note.text,
    author: nameOf(viewer.names, note.author),
    client: clientOf(viewer, note.session),
    at: note.at.toISOString(),
  };
}

/** What a step of the log is in a task's life; null for one that is none of its turns, such as a note. */
function turnOf(step: TaskStep): Pick<TaskEvent, "event" | "after"> | null {
  switch (step.kind) {
    case "TaskPublished":
      return { event: "published" };
    case "TaskClaimed": {
      const from = step.payload.from;
      return {
        event: "claimed",
        ...(from === "lapsed" || from === "take_over" ? { after: from } : {}),
      };
    }
    case "TaskReleased":
      return { event: step.payload.handed_off === true ? "handed_off" : "released" };
    case "TaskDone":
      return { event: "done" };
    default:
      return null;
  }
}

/** A task's life as the log holds it: who published, claimed, released and finished it. Notes are listed apart. */
export function historyView(steps: readonly TaskStep[], viewer: Viewer): TaskEvent[] {
  return steps.flatMap((step) => {
    const event = turnOf(step);
    if (event === null) return [];
    const session = step.session === null ? undefined : viewer.sessions.get(step.session);
    const by = step.actor.kind === "person" ? nameOf(viewer.names, step.actor.id) : step.actor.job;
    return [
      {
        ...event,
        by,
        client: session?.clientName,
        session: session?.displayId,
        at: step.at.toISOString(),
      },
    ];
  });
}

const via = (client: string | undefined): string => (client === undefined ? "" : ` via ${client}`);

function holderPhrase(view: TaskView): string {
  const here = view.held_by_this_session === true ? " (this session)" : "";
  return `${view.holder ?? "someone"}${via(view.holder_client)}${here}`;
}

/** Where a task stands, in words: who holds it and until when, or that its lease lapsed. */
export function standingPhrase(view: TaskView): string {
  if (view.lapsed === true) {
    return `open · lease lapsed ${view.lease_expires_at} (was held by ${holderPhrase(view)})`;
  }
  if (view.state === "claimed") {
    return `claimed by ${holderPhrase(view)} until ${view.lease_expires_at}`;
  }
  return view.state === "handed_off" ? "handed off" : view.state;
}

/** A task in a list: its line, its description when the view has one, and its newest note unless the notes follow. */
export function taskLines(view: TaskView, withNote: boolean): string[] {
  const kind = view.note_kind === "handoff" ? "handoff note" : "note";
  const from = `${view.note_by}${via(view.note_client)}, ${view.note_at}`;
  const tracked = view.tracked === true ? " · tracked" : "";
  return [
    `${view.id} · ${view.title} · ${standingPhrase(view)} · v${view.version}${tracked}`,
    ...(view.description === undefined ? [] : [`  ${view.description}`]),
    ...(withNote && view.note !== undefined ? [`  ${kind} (${from}): ${view.note}`] : []),
  ];
}

function noteLine(note: NoteView): string {
  const kind = note.kind === "handoff" ? "handoff note" : "note";
  return `  ${note.at} · ${kind} by ${note.author}${via(note.client)}: ${note.text}`;
}

function eventLine(event: TaskEvent): string {
  const session = event.session === undefined ? "" : ` (${event.session})`;
  const after = { lapsed: ", after the lease lapsed", take_over: ", taking it over", none: "" };
  const what = event.event === "handed_off" ? "handed off" : event.event;
  return `  ${event.at} · ${what} by ${event.by}${via(event.client)}${session}${after[event.after ?? "none"]}`;
}

export function renderSearchTasks(result: SearchTasksResult): string {
  const { notes = [], history = [] } = result;
  const lines = result.tasks.flatMap((task) => taskLines(task, notes.length === 0));
  const head =
    result.tasks.length === 0
      ? [result.message ?? NO_TASKS]
      : [`${result.matched} matched · ${result.shown} shown`, ...lines];
  return [
    ...head,
    ...(notes.length === 0 ? [] : ["notes, oldest first:", ...notes.map(noteLine)]),
    ...(history.length === 0 ? [] : ["history:", ...history.map(eventLine)]),
    ...footer(result),
  ].join("\n");
}

function leaseLine(lease: string, view: TaskView): string {
  return `lease: ${lease} · pass it as lease to update_task · ends ${view.lease_expires_at} unless a call renews it`;
}

export function renderPublishTask(result: PublishTaskResult): string {
  const { task, lease } = result;
  const held = lease === undefined && !result.created && task.state === "claimed";
  return [
    `${result.created ? "published" : "already published"} task ${task.id} · ${task.title} · ${standingPhrase(task)} · v${task.version}`,
    ...(lease === undefined ? [] : [leaseLine(lease, task)]),
    ...(held ? ["no lease was taken: the task is already held"] : []),
    ...footer(result),
  ].join("\n");
}

export function renderClaimTask(result: ClaimTaskResult): string {
  const { task } = result;
  return [
    `${result.renewed ? "renewed the lease on" : "claimed"} task ${task.id} · ${task.title} · v${task.version}`,
    leaseLine(result.lease, task),
    ...(task.description === undefined ? [] : [`  ${task.description}`]),
    ...(result.notes.length === 0 ? [] : ["notes, oldest first:", ...result.notes.map(noteLine)]),
    ...footer(result),
  ].join("\n");
}

export function renderUpdateTask(result: UpdateTaskResult): string {
  const { task } = result;
  const head = result.changed ? "updated" : "nothing changed on";
  return [
    `${head} task ${task.id} · ${standingPhrase(task)} · v${task.version}`,
    ...footer(result),
  ].join("\n");
}
