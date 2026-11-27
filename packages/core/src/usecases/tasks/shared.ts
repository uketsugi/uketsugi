/** What the four task tools share: finding a task, proving and granting a lease, events, views and refusals. */
import type { Task as TaskView } from "@uketsugi/contracts";
import { eventOf, idOf, namesFor, scopeOf, type Acting, type CallContext } from "../../context.ts";
import type { Caller, EventDraft, EventPayloads, Session, Task, TaskNote } from "../../domain.ts";
import { notFound, ToolFailure } from "../../failure.ts";
import { sha256Hex, toHex } from "../../hash.ts";
import type { CorePorts } from "../../ports.ts";
import { scanFields } from "../../scan/scanner.ts";
import { holderOfTask, requireSharing, type Place } from "../../sharing.ts";
import type { TaskStep, UnitWrites } from "../../store-port.ts";
import { DEFAULT_TASK_LEASE_MS, type ClaimDecision } from "../../tasks/lease.ts";
import { standingPhrase, taskView, type Viewer } from "../../tasks/views.ts";

/** What a call's unit is opened as: the caller, in the call's project, at one instant. */
export function personOf(ctx: CallContext, at: Date) {
  return { caller: ctx.caller, project: ctx.project.key, at };
}

/**
 * The task a call names, found inside the caller's unit, with the writes of the audience that
 * holds it. A task the caller cannot see, or of another project, reads as absent; a shared one is
 * written only from a project the caller's person shares, as their choice stands in the unit.
 */
export async function taskIn(
  place: Place,
  ctx: CallContext,
  id: string,
): Promise<{ writes: UnitWrites; task: Task }> {
  const held = await holderOfTask(place, idOf(id));
  if (held === null || held.task.project !== ctx.project.key) throw notFound("task", id);
  requireSharing(place, held.writes, `Task ${held.task.id}`);
  return held;
}

/** When a lease taken or renewed at `at` ends. */
export function leaseEnd(ports: Pick<CorePorts, "taskLeaseMs">, at: Date): Date {
  return new Date(at.getTime() + (ports.taskLeaseMs ?? DEFAULT_TASK_LEASE_MS));
}

/** The same lease on the task, ending later: as from `at`. */
export async function renewLease(
  ports: Pick<CorePorts, "taskLeaseMs">,
  unit: UnitWrites,
  task: Task,
  at: Date,
): Promise<Task> {
  return (await unit.tasks.renew(task.id, leaseEnd(ports, at))) ?? task;
}

/**
 * A text of a task write as it may be stored. The scanner runs first on every write, so a secret
 * in a title, a description or a note is replaced before anything is compared or kept. A blank
 * text reads as absent.
 */
export function storable(text: string | undefined): string | null {
  return scanFields({ text }).fields.text;
}

/** The hash of the lease a call passed, or null when it passed none. */
export async function tokenHashOf(lease: string | undefined): Promise<string | null> {
  const token = lease?.trim() ?? "";
  return token === "" ? null : sha256Hex(token);
}

type ChangeKind = "TaskPublished" | "TaskClaimed" | "TaskReleased" | "TaskDone" | "TaskNoted";

/** A change to a task, with its event's payload but for the version, which `taskEvent` adds. */
export type TaskChange = {
  [K in ChangeKind]: { kind: K; payload: Omit<EventPayloads[K], "version"> };
}[ChangeKind];

/**
 * An event about a task as it stands after the change. The payload says which version the change
 * made; which session it came from is the event's own to say.
 */
export function taskEvent(ctx: Acting, task: Task, change: TaskChange): EventDraft {
  return eventOf(ctx, change.kind, task.id, { version: task.version, ...change.payload });
}

type Grant = Extract<ClaimDecision, { kind: "grant" }>;

/**
 * Gives the task a new lease with a new token: the one write behind `claim_task` and
 * `publish_task` with `claim`. The token of any lease before it stops working here.
 */
export async function grantLease(
  ports: Pick<CorePorts, "ids" | "taskLeaseMs">,
  ctx: CallContext,
  unit: UnitWrites,
  task: Task,
  from: Grant["from"],
  at: Date,
): Promise<{ task: Task; token: string }> {
  const token = `ukl_${toHex(ports.ids.bytes(16))}`;
  const lease = {
    tokenHash: await sha256Hex(token),
    holder: ctx.caller.principalId,
    session: ctx.session.id,
    expiresAt: leaseEnd(ports, at),
  };
  const claimed = await unit.tasks.change(task.id, task.version, { state: "claimed", lease });
  if (claimed === null) throw new Error(`task ${task.id} changed under the unit that locked it`);
  const payload = {
    from,
    ...(task.lease === null ? {} : { previous_holder: task.lease.holder }),
    lease_until: lease.expiresAt.toISOString(),
  };
  await unit.append(taskEvent(ctx, claimed, { kind: "TaskClaimed", payload }));
  return { task: claimed, token };
}

/** Who tasks are read for: a tool call's caller in its session, or a person on the dashboard, who is in none. */
export interface Reader {
  readonly caller: Caller;
  readonly session?: Pick<Session, "id">;
}

/** What views of these tasks, notes and steps are drawn for: the people and the sessions they name, read once. */
export async function viewerOf(
  ports: Pick<CorePorts, "store">,
  reader: Reader,
  now: Date,
  records: { tasks: readonly Task[]; notes: readonly TaskNote[]; steps?: readonly TaskStep[] },
): Promise<Viewer> {
  const { tasks, notes, steps = [] } = records;
  const { caller } = reader;
  const leases = tasks.flatMap((task) => (task.lease === null ? [] : [task.lease]));
  const people = [
    ...tasks.map((task) => task.publisher),
    ...leases.map((lease) => lease.holder),
    ...notes.map((note) => note.author),
    ...steps.flatMap((step) => (step.actor.kind === "person" ? [step.actor.id] : [])),
  ];
  const sessionIds = [
    ...leases.map((lease) => lease.session),
    ...notes.map((note) => note.session),
    ...steps.flatMap((step) => (step.session === null ? [] : [step.session])),
  ];
  const [names, sessions] = await Promise.all([
    namesFor(ports, caller, people),
    ports.store.sessions.byIds(caller.orgId, [...new Set(sessionIds)]),
  ]);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return { now, sessionId: reader.session?.id ?? null, names, sessions: byId };
}

/** One task as a result shows it: whole, with its newest note. */
export async function wholeView(
  ports: Pick<CorePorts, "store">,
  ctx: CallContext,
  task: Task,
  now: Date,
): Promise<TaskView> {
  const notes = await ports.store.tasks.latestNotes(scopeOf(ctx.caller), [task.id]);
  const viewer = await viewerOf(ports, ctx, now, { tasks: [task], notes });
  return taskView(task, notes[0] ?? null, viewer, true);
}

const NEXT_WHEN_HELD = {
  claim_task:
    "If you hold it, pass your lease. Otherwise it can be claimed once the lease ends, unless its holder renews it; search_tasks with its id shows it meanwhile.",
  take_over:
    "If you hold it, pass your lease. If the session that holds it is gone, or the person asks you to take it, call claim_task with take_over: true. Otherwise it can be claimed once the lease ends, unless its holder renews it.",
  update_task:
    "Stop changing this task: a newer claim replaced the lease this call passed, or it passed none. search_tasks with its id shows who holds it and its notes; claim it again only if the person asks.",
} as const;

/** A live lease that is not the call's: the refusal names the holder's person and when the lease ends. */
export function leaseHeld(view: TaskView, next: keyof typeof NEXT_WHEN_HELD): ToolFailure {
  return new ToolFailure("lease_held", {
    what: `Task ${view.id} is ${standingPhrase(view)}.`,
    meaning:
      "One lease holds a task at a time and this call did not pass it, so nothing was changed.",
    next: NEXT_WHEN_HELD[next],
    details: { task: view },
  });
}

/** The task is not in a state the change applies to. The task as it stands goes with the refusal. */
export function conflict(
  reason: "not_claimed" | "done" | "stale_version",
  view: TaskView,
  named?: number,
): ToolFailure {
  const stands = standingPhrase(view);
  const texts = {
    not_claimed: {
      what: `Task ${view.id} is ${stands}: no lease holds it.`,
      meaning: "A change needs the task's lease, so nothing was changed.",
      next: "Call claim_task to take it, then pass the lease it returns.",
    },
    done: {
      what: `Task ${view.id} is done.`,
      meaning: "A finished task takes no more changes, so nothing was changed.",
      next: "Publish a new task if more work is needed.",
    },
    stale_version: {
      what: `Task ${view.id} is at version ${view.version} (${stands}), not version ${named}.`,
      meaning:
        "The task changed after the version this call was made against, so nothing was changed.",
      next: `Repeat the change against version ${view.version} if it still applies.`,
    },
  };
  return new ToolFailure("conflict", { ...texts[reason], details: { reason, task: view } });
}
