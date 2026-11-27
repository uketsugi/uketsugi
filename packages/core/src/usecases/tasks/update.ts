import type { TaskClosed, UpdateTaskInput, UpdateTaskResult } from "@uketsugi/contracts";
import type { Caller, Task, TaskState } from "../../domain.ts";
import { forbidden, invalidInput, notFound } from "../../failure.ts";
import type { UnitWrites } from "../../store-port.ts";
import { decideUpdate, type UpdateAsk, type UpdateRefusal } from "../../tasks/lease.ts";
import { idOf, type CallContext, type Outcome } from "../../context.ts";
import type { CorePorts } from "../../ports.ts";
import { asPerson, holderOfTask, requireSharing } from "../../sharing.ts";
import {
  conflict,
  leaseEnd,
  leaseHeld,
  storable,
  personOf,
  renewLease,
  taskEvent,
  type TaskChange,
  taskIn,
  tokenHashOf,
  wholeView,
} from "./shared.ts";

/**
 * Makes the change the lease machine allowed: the task goes to `state` at its next version, a note
 * is added if the call brought one, and one event records it. A task that stays claimed has its
 * lease renewed; a release or a completion frees it.
 */
async function apply(
  ports: CorePorts,
  ctx: CallContext,
  unit: UnitWrites,
  change: { task: Task; ask: UpdateAsk; state: TaskState; at: Date },
): Promise<Task> {
  const { task, ask, state, at } = change;
  const stays = state === "claimed" && task.lease !== null;
  const lease = stays ? { ...task.lease, expiresAt: leaseEnd(ports, at) } : null;
  const changed = await unit.tasks.change(task.id, task.version, { state, lease });
  if (changed === null) throw new Error(`task ${task.id} changed under the unit that locked it`);
  const note = ask.note === null ? null : ports.ids.uuid();
  if (ask.note !== null && note !== null) {
    await unit.tasks.addNote({
      taskId: task.id,
      id: note,
      kind: ask.state === "released" ? "handoff" : "note",
      author: ctx.caller.principalId,
      session: ctx.session.id,
      text: ask.note,
    });
  }
  const noted = note === null ? {} : { note };
  const event: TaskChange =
    state === "done"
      ? { kind: "TaskDone", payload: noted }
      : state === "claimed"
        ? { kind: "TaskNoted", payload: noted }
        : { kind: "TaskReleased", payload: { ...noted, handed_off: state === "handed_off" } };
  await unit.append(taskEvent(ctx, changed, event));
  return changed;
}

/**
 * Changes a task under its lease (flow F5): a note at a checkpoint, a release that hands it over
 * with a note or reopens it without one, or its completion. Every call from the holder renews the
 * lease; a call with the lease and nothing else only renews it. A change already applied changes
 * nothing. Without the task's lease the call is refused: with the holder's person while a lease is
 * live, or with what the task now is.
 */
export async function updateTask(
  ports: CorePorts,
  ctx: CallContext,
  input: UpdateTaskInput,
): Promise<Outcome<UpdateTaskResult>> {
  const tokenHash = await tokenHashOf(input.lease);
  const ask: UpdateAsk = {
    tokenHash,
    note: storable(input.note),
    state: input.state ?? null,
    version: input.version ?? null,
  };
  if (ask.note === null && ask.state === null && tokenHash === null) {
    throw invalidInput(
      "update_task was called with nothing to change.",
      "Pass note, state or both, with the lease claim_task returned.",
    );
  }
  const at = ports.clock.now();

  const done = await asPerson(
    ports,
    personOf(ctx, at),
    async (place): Promise<{ task: Task; changed: boolean; refused?: UpdateRefusal }> => {
      const { writes: unit, task } = await taskIn(place, ctx, input.id);
      const decision = decideUpdate(task, ask, await unit.tasks.lastNote(task.id), at);
      switch (decision.kind) {
        case "apply": {
          const change = { task, ask, state: decision.state, at };
          return { task: await apply(ports, ctx, unit, change), changed: true };
        }
        case "renew": {
          return { task: await renewLease(ports, unit, task, at), changed: false };
        }
        case "unchanged":
          return { task, changed: false };
        case "refuse":
          return { task, changed: false, refused: decision.reason };
      }
    },
  );

  const view = await wholeView(ports, ctx, done.task, at);
  if (done.refused === "held") throw leaseHeld(view, "update_task");
  if (done.refused !== undefined) throw conflict(done.refused, view, input.version);
  return { task: view, changed: done.changed };
}

/**
 * A person closes a task of theirs (one they published, or their agent holds) on the dashboard: it is done, whoever holds its lease, and the lease is
 * freed. The log's entry names the person and no session. Closing a task that is done changes
 * nothing.
 */
export async function closeTask(
  ports: Pick<CorePorts, "store" | "clock">,
  caller: Caller,
  id: string,
): Promise<TaskClosed> {
  const scope = { orgId: caller.orgId, audienceIds: caller.visibleAudienceIds };
  const seen = await ports.store.tasks.get(scope, idOf(id));
  if (seen === null) throw notFound("listed task", id);
  const at = ports.clock.now();
  const changed = await asPerson(ports, { caller, project: seen.project, at }, async (place) => {
    const held = await holderOfTask(place, seen.id);
    if (held === null) throw notFound("listed task", id);
    const { writes, task } = held;
    requireSharing(place, writes, `Task ${task.id}`);
    if (task.publisher !== caller.principalId && task.lease?.holder !== caller.principalId) {
      throw forbidden(
        `Task ${task.id} is another person's.`,
        "Only the person who published a task, or whose agent holds it, closes it from the dashboard.",
      );
    }
    if (task.state === "done") return false;
    const done = await writes.tasks.change(task.id, task.version, { state: "done", lease: null });
    if (done === null) throw new Error(`task ${task.id} changed under the unit that locked it`);
    await writes.append(
      taskEvent({ caller, session: null }, done, { kind: "TaskDone", payload: {} }),
    );
    return true;
  });
  return { id: seen.id, changed };
}
