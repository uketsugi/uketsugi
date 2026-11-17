import type { PublishTaskInput, PublishTaskResult } from "@uketsugi/contracts";
import type { Task } from "../../domain.ts";
import { invalidInput } from "../../failure.ts";
import type { UnitWrites } from "../../store-port.ts";
import { decideClaim } from "../../tasks/lease.ts";
import type { CallContext, Outcome } from "../../context.ts";
import type { CorePorts } from "../../ports.ts";
import { asPerson, taskLanding } from "../../sharing.ts";
import { grantLease, personOf, storable, taskEvent, wholeView } from "./shared.ts";

/** A title as it is stored and as two publishes of it are compared: scanned, on one line, with single spaces. */
function oneLine(title: string): string {
  return (storable(title) ?? "").replace(/\s+/g, " ");
}

async function insert(
  ports: CorePorts,
  ctx: CallContext,
  unit: UnitWrites,
  input: PublishTaskInput,
  title: string,
): Promise<Task> {
  const id = ports.ids.uuid();
  await unit.tasks.insert({
    id,
    project: ctx.project.key,
    title,
    description: storable(input.description),
    tracked: input.tracked === true,
    publisher: ctx.caller.principalId,
    lease: null,
  });
  const task = await unit.tasks.get(id);
  if (task === null) throw new Error("a published task was not readable inside its own unit");
  await unit.append(
    taskEvent(ctx, task, { kind: "TaskPublished", payload: { tracked: task.tracked } }),
  );
  return task;
}

/**
 * Publishes a task (flow F5), open for whoever takes it: to everyone on the server when the
 * caller's person shares the project, unless it is a step of the agent's own plan, and otherwise
 * to the person alone. With `claim` the caller takes it in the same unit. A repeated publish returns the person's unfinished
 * task of the same title in this project; with `claim` it takes that task if no live lease holds
 * it, and never a second lease on one that is held.
 */
export async function publishTask(
  ports: CorePorts,
  ctx: CallContext,
  input: PublishTaskInput,
): Promise<Outcome<PublishTaskResult>> {
  const title = oneLine(input.title);
  if (title === "") throw invalidInput("title is empty.", "Pass the work in one line as title.");
  const at = ports.clock.now();
  const person = ctx.caller.principalId;

  const stored = await asPerson(ports, personOf(ctx, at), async (place) => {
    // Where it lands follows the person's choice as it stands inside the unit.
    const unit = await taskLanding(place, input.tracked === true);
    const existing = await unit.tasks.findOpenByTitle(person, ctx.project.key, title);
    const task = existing ?? (await insert(ports, ctx, unit, input, title));
    const created = existing === null;
    if (input.claim !== true) return { task, created, token: null };
    const decision = decideClaim(task, { person, tokenHash: null, takeOver: false }, at);
    if (decision.kind !== "grant") return { task, created, token: null };
    return { ...(await grantLease(ports, ctx, unit, task, decision.from, at)), created };
  });

  return {
    task: await wholeView(ports, ctx, stored.task, at),
    created: stored.created,
    ...(stored.token === null ? {} : { lease: stored.token }),
  };
}
