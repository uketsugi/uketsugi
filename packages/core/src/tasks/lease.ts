/**
 * The lease state machine. A task is held by one lease at a time, and the lease is its token:
 * `claim_task` returns the token, every change passes it back, and only its hash is stored. Each
 * function here decides one call from the task as it was read under the audience's lock, the hash
 * of the token the call passed, and the clock's reading. Nothing here reads a clock or a store.
 *
 * The rules:
 * - A lease lasts `DEFAULT_TASK_LEASE_MS` unless the server is set otherwise, and every call from
 *   its holder renews it.
 * - A lease that ran out is not removed: the task stands as `lapsed`, anyone may claim it, and the
 *   new claim's token replaces the old one, which is how a late holder is stopped. Until someone
 *   claims it, the old holder's token still works and its next call revives the lease.
 * - A live lease is taken from its holder only by the same person asking to take it over.
 * - A change that was already applied changes nothing, whichever version it names.
 */
import type { ClaimedFrom, Task, TaskNote, TaskState } from "../domain.ts";

/** How long a lease lasts when the server is not told otherwise: fifteen minutes. */
export const DEFAULT_TASK_LEASE_MS = 15 * 60 * 1000;

/** Where a task stands for someone who wants to work on it. `lapsed` is a claim whose lease ran out. */
export type Standing = "open" | "handed_off" | "lapsed" | "claimed" | "done";

type Leased = Pick<Task, "state" | "lease">;

/** A lease holds while the clock is before its end; at its end it has run out. */
export function leaseStanding(task: Leased, now: Date): Standing {
  if (task.state !== "claimed") return task.state;
  const live = task.lease !== null && now.getTime() < task.lease.expiresAt.getTime();
  return live ? "claimed" : "lapsed";
}

/** Whether the call passed the token of the lease on the task, live or lapsed. */
function holds(task: Leased, tokenHash: string | null): boolean {
  return tokenHash !== null && task.lease !== null && task.lease.tokenHash === tokenHash;
}

/** What a claim says of itself: who asks, the hash of the lease it passed, and whether it takes over. */
export interface ClaimAsk {
  readonly person: string;
  readonly tokenHash: string | null;
  readonly takeOver: boolean;
}

export type ClaimDecision =
  /** A new lease with a new token. `from` is where the task stood. */
  | { readonly kind: "grant"; readonly from: ClaimedFrom }
  /** The caller passed the lease the task holds: the same lease, with a later end. */
  | { readonly kind: "renew" }
  /** A live lease that is not the caller's. */
  | { readonly kind: "held" }
  | { readonly kind: "done" };

/** Decides a claim. */
export function decideClaim(task: Leased, ask: ClaimAsk, now: Date): ClaimDecision {
  const standing = leaseStanding(task, now);
  if (standing === "done") return { kind: "done" };
  if (standing === "open" || standing === "handed_off") return { kind: "grant", from: standing };
  if (holds(task, ask.tokenHash)) return { kind: "renew" };
  if (standing === "lapsed") return { kind: "grant", from: "lapsed" };
  const own = task.lease?.holder === ask.person;
  return ask.takeOver && own ? { kind: "grant", from: "take_over" } : { kind: "held" };
}

/** What an update asks for, with absent fields as null. */
export interface UpdateAsk {
  readonly tokenHash: string | null;
  readonly note: string | null;
  readonly state: "done" | "released" | null;
  readonly version: number | null;
}

export type UpdateRefusal = "held" | "not_claimed" | "done" | "stale_version";

export type UpdateDecision =
  /** The change is made: the task goes to `state`, and its lease is renewed or freed. */
  | { readonly kind: "apply"; readonly state: TaskState }
  /** Nothing changes but the end of the caller's lease. */
  | { readonly kind: "renew" }
  /** The change was already applied, and the caller holds no lease to renew. */
  | { readonly kind: "unchanged" }
  | { readonly kind: "refuse"; readonly reason: UpdateRefusal };

type LastNote = Pick<TaskNote, "kind" | "text"> | null;

/** Whether the task already is what the update would make it: a repeated call, not a new change. */
function alreadyApplied(task: Leased, ask: UpdateAsk, last: LastNote): boolean {
  const sameNote = ask.note === null || last?.text === ask.note;
  if (ask.state === "done") return task.state === "done" && sameNote;
  if (ask.state !== "released") return false;
  if (ask.note === null) return task.state === "open" || task.state === "handed_off";
  return task.state === "handed_off" && last?.kind === "handoff" && sameNote;
}

/**
 * Decides an update. In order: a change already applied changes nothing; a finished task takes no
 * change; a change needs the task's lease; the holder's repeated note only renews; a change made
 * against another version than the task's is refused.
 */
export function decideUpdate(
  task: Pick<Task, "state" | "lease" | "version">,
  ask: UpdateAsk,
  last: LastNote,
  now: Date,
): UpdateDecision {
  const holder = holds(task, ask.tokenHash);
  if (alreadyApplied(task, ask, last)) return { kind: "unchanged" };
  const standing = leaseStanding(task, now);
  if (standing === "done") return { kind: "refuse", reason: "done" };
  if (!holder) return { kind: "refuse", reason: standing === "claimed" ? "held" : "not_claimed" };
  if (ask.state === null && (ask.note === null || last?.text === ask.note)) {
    return { kind: "renew" };
  }
  if (ask.version !== null && ask.version !== task.version) {
    return { kind: "refuse", reason: "stale_version" };
  }
  if (ask.state === "done") return { kind: "apply", state: "done" };
  if (ask.state === "released") {
    return { kind: "apply", state: ask.note === null ? "open" : "handed_off" };
  }
  return { kind: "apply", state: "claimed" };
}

/** What a caller could pick up comes first: a handover, then a lapsed lease, then open work. */
const PICK_UP_ORDER: Readonly<Record<Standing, number>> = {
  handed_off: 0,
  lapsed: 1,
  open: 2,
  claimed: 3,
  done: 4,
};

type Ordered = Pick<Task, "id" | "state" | "lease" | "createdAt" | "updatedAt">;

/**
 * Tasks in the order a caller could pick them up. Open work queues oldest first; within every
 * other standing the latest change comes first.
 */
export function inPickUpOrder<T extends Ordered>(tasks: readonly T[], now: Date): T[] {
  const ranked = tasks.map((task) => ({ task, standing: leaseStanding(task, now) }));
  ranked.sort((a, b) => {
    const byStanding = PICK_UP_ORDER[a.standing] - PICK_UP_ORDER[b.standing];
    if (byStanding !== 0) return byStanding;
    const byTime =
      a.standing === "open"
        ? a.task.createdAt.getTime() - b.task.createdAt.getTime()
        : b.task.updatedAt.getTime() - a.task.updatedAt.getTime();
    return byTime !== 0 ? byTime : a.task.id.localeCompare(b.task.id);
  });
  return ranked.map((entry) => entry.task);
}
