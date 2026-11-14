import type { ClaimTaskInput, ClaimTaskResult } from "@uketsugi/contracts";
import { decideClaim } from "../../tasks/lease.ts";
import { noteView } from "../../tasks/views.ts";
import { scopeOf, type CallContext, type Outcome } from "../../context.ts";
import type { CorePorts } from "../../ports.ts";
import { asPerson } from "../../sharing.ts";
import {
  conflict,
  grantLease,
  leaseEnd,
  leaseHeld,
  personOf,
  taskIn,
  tokenHashOf,
  viewerOf,
  wholeView,
} from "./shared.ts";

/** How many of a task's notes a claim returns: the newest ones, where the work stands. */
const NOTES_ON_CLAIM = 10;

/**
 * Takes a task's lease (flow F5) and returns its token with the task's notes, so the taker starts
 * from where the work stands. A task that is open, handed off or whose lease lapsed is granted. A
 * live lease is renewed for the caller that passes its token, taken over by the same person on
 * request, and otherwise refused with the holder's person and the lease's end.
 */
export async function claimTask(
  ports: CorePorts,
  ctx: CallContext,
  input: ClaimTaskInput,
): Promise<Outcome<ClaimTaskResult>> {
  const tokenHash = await tokenHashOf(input.lease);
  const at = ports.clock.now();
  const ask = { person: ctx.caller.principalId, tokenHash, takeOver: input.take_over === true };

  const taken = await asPerson(ports, personOf(ctx, at), async (place) => {
    const { writes: unit, task } = await taskIn(place, ctx, input.id);
    const decision = decideClaim(task, ask, at);
    if (decision.kind === "grant") {
      return { ...(await grantLease(ports, ctx, unit, task, decision.from, at)), renewed: false };
    }
    if (decision.kind === "renew") {
      const renewed = await unit.tasks.renew(task.id, leaseEnd(ports, at));
      return { task: renewed ?? task, token: input.lease?.trim() ?? "", renewed: true };
    }
    return { task, refused: decision.kind };
  });

  const view = await wholeView(ports, ctx, taken.task, at);
  if ("refused" in taken) {
    if (taken.refused === "done") throw conflict("done", view);
    const own = taken.task.lease?.holder === ctx.caller.principalId;
    throw leaseHeld(view, own ? "take_over" : "claim_task");
  }
  const notes = await ports.store.tasks.notes(scopeOf(ctx.caller), [taken.task.id]);
  const latest = notes.slice(-NOTES_ON_CLAIM);
  const viewer = await viewerOf(ports, ctx, at, { tasks: [], notes: latest });
  return {
    task: view,
    lease: taken.token,
    renewed: taken.renewed,
    notes: latest.map((note) => noteView(note, viewer)),
  };
}
