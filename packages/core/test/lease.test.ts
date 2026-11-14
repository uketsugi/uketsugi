import { describe, expect, test } from "vitest";
import type { Task, TaskLease } from "../src/domain.ts";
import {
  DEFAULT_TASK_LEASE_MS,
  decideClaim,
  decideUpdate,
  inPickUpOrder,
  leaseStanding,
  type UpdateAsk,
} from "../src/tasks/lease.ts";

/** A clock that moves only when a test moves it. The machine never reads one: it is handed the reading. */
class Clock {
  private ms = Date.parse("2026-01-01T10:00:00.000Z");
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

const ALICE = "person-alice";
const BOB = "person-bob";
const TOKEN = "hash-of-the-first-token";
const NEWER = "hash-of-the-second-token";

function leaseAt(clock: Clock, tokenHash = TOKEN): TaskLease {
  const expiresAt = new Date(clock.now().getTime() + DEFAULT_TASK_LEASE_MS);
  return { tokenHash, holder: ALICE, session: "session-1", expiresAt };
}

function task(state: Task["state"], lease: TaskLease | null = null, version = 3) {
  return { state, lease, version };
}

function ask(fields: Partial<UpdateAsk>): UpdateAsk {
  return { tokenHash: null, note: null, state: null, version: null, ...fields };
}

const claim = (tokenHash: string | null = null, takeOver = false, person = ALICE) => ({
  person,
  tokenHash,
  takeOver,
});

describe("a lease's standing", () => {
  test("a lease holds until its end and has lapsed at it", () => {
    const clock = new Clock();
    const held = task("claimed", leaseAt(clock));
    expect(leaseStanding(held, clock.now())).toBe("claimed");
    clock.advance(DEFAULT_TASK_LEASE_MS - 1);
    expect(leaseStanding(held, clock.now())).toBe("claimed");
    clock.advance(1);
    expect(leaseStanding(held, clock.now())).toBe("lapsed");
  });

  test("a task that is not claimed stands as its state says, whatever the clock", () => {
    const clock = new Clock();
    for (const state of ["open", "handed_off", "done"] as const) {
      expect(leaseStanding(task(state), clock.now())).toBe(state);
    }
  });
});

describe("claiming", () => {
  test("an open or handed-off task is granted, and a finished one is not", () => {
    const now = new Clock().now();
    expect(decideClaim(task("open"), claim(), now)).toEqual({ kind: "grant", from: "open" });
    expect(decideClaim(task("handed_off"), claim(), now)).toEqual({
      kind: "grant",
      from: "handed_off",
    });
    expect(decideClaim(task("done"), claim(), now)).toEqual({ kind: "done" });
  });

  test("a live lease is held against everyone but the bearer of its token", () => {
    const clock = new Clock();
    const held = task("claimed", leaseAt(clock));
    expect(decideClaim(held, claim(), clock.now())).toEqual({ kind: "held" });
    expect(decideClaim(held, claim(NEWER), clock.now())).toEqual({ kind: "held" });
    expect(decideClaim(held, claim(TOKEN), clock.now())).toEqual({ kind: "renew" });
  });

  test("the same person takes a live lease over on request; another person never does", () => {
    const clock = new Clock();
    const held = task("claimed", leaseAt(clock));
    expect(decideClaim(held, claim(null, true), clock.now())).toEqual({
      kind: "grant",
      from: "take_over",
    });
    expect(decideClaim(held, claim(null, true, BOB), clock.now())).toEqual({ kind: "held" });
  });

  test("a lease left alone lapses and the task is granted to whoever claims it", () => {
    const clock = new Clock();
    const held = task("claimed", leaseAt(clock));
    clock.advance(DEFAULT_TASK_LEASE_MS);
    expect(decideClaim(held, claim(null, false, BOB), clock.now())).toEqual({
      kind: "grant",
      from: "lapsed",
    });
    expect(decideClaim(held, claim(TOKEN), clock.now())).toEqual({ kind: "renew" });
  });
});

describe("updating", () => {
  test("the holder's note keeps the task claimed, a release frees it and done finishes it", () => {
    const clock = new Clock();
    const held = task("claimed", leaseAt(clock));
    const by = (fields: Partial<UpdateAsk>) =>
      decideUpdate(held, ask({ tokenHash: TOKEN, ...fields }), null, clock.now());
    expect(by({ note: "half way" })).toEqual({ kind: "apply", state: "claimed" });
    expect(by({ state: "released", note: "left to do: the tests" })).toEqual({
      kind: "apply",
      state: "handed_off",
    });
    expect(by({ state: "released" })).toEqual({ kind: "apply", state: "open" });
    expect(by({ state: "done" })).toEqual({ kind: "apply", state: "done" });
    expect(by({})).toEqual({ kind: "renew" });
  });

  test("a write without the live lease's token is refused as held", () => {
    const clock = new Clock();
    const reclaimed = task("claimed", leaseAt(clock, NEWER));
    const refused = { kind: "refuse", reason: "held" };
    expect(decideUpdate(reclaimed, ask({ note: "late" }), null, clock.now())).toEqual(refused);
    const stale = ask({ tokenHash: TOKEN, state: "done" });
    expect(decideUpdate(reclaimed, stale, null, clock.now())).toEqual(refused);
  });

  test("a lapsed lease nobody took still answers its holder, and nobody else", () => {
    const clock = new Clock();
    const held = task("claimed", leaseAt(clock));
    clock.advance(DEFAULT_TASK_LEASE_MS + 60_000);
    expect(decideUpdate(held, ask({ tokenHash: TOKEN, note: "back" }), null, clock.now())).toEqual({
      kind: "apply",
      state: "claimed",
    });
    expect(decideUpdate(held, ask({ note: "not mine" }), null, clock.now())).toEqual({
      kind: "refuse",
      reason: "not_claimed",
    });
  });

  test("a task nobody holds takes no change, and a finished one takes none at all", () => {
    const now = new Clock().now();
    const note = ask({ tokenHash: TOKEN, note: "more" });
    for (const state of ["open", "handed_off"] as const) {
      expect(decideUpdate(task(state), note, null, now)).toEqual({
        kind: "refuse",
        reason: "not_claimed",
      });
    }
    expect(decideUpdate(task("done"), note, null, now)).toEqual({ kind: "refuse", reason: "done" });
  });

  test("a change already applied changes nothing, whatever version it names", () => {
    const clock = new Clock();
    const now = clock.now();
    const handoff = { kind: "handoff" as const, text: "left to do: the tests" };
    const unchanged = { kind: "unchanged" };
    const released = ask({ tokenHash: TOKEN, state: "released", version: 1 });
    expect(decideUpdate(task("open"), released, null, now)).toEqual(unchanged);
    const handed = { ...released, note: handoff.text };
    expect(decideUpdate(task("handed_off"), handed, handoff, now)).toEqual(unchanged);
    const finished = ask({ tokenHash: TOKEN, state: "done", version: 1 });
    expect(decideUpdate(task("done"), finished, handoff, now)).toEqual(unchanged);
    const held = task("claimed", leaseAt(clock));
    const repeated = ask({ tokenHash: TOKEN, note: "half way", version: 1 });
    const last = { kind: "note" as const, text: "half way" };
    expect(decideUpdate(held, repeated, last, now)).toEqual({ kind: "renew" });
  });

  test("a different handoff of a task already handed off is not a repeat", () => {
    const now = new Clock().now();
    const other = ask({ tokenHash: TOKEN, state: "released", note: "another note" });
    const last = { kind: "handoff" as const, text: "left to do: the tests" };
    expect(decideUpdate(task("handed_off"), other, last, now)).toEqual({
      kind: "refuse",
      reason: "not_claimed",
    });
  });

  test("a change made against another version than the task's is refused", () => {
    const clock = new Clock();
    const held = task("claimed", leaseAt(clock), 5);
    const at = (version: number) =>
      decideUpdate(held, ask({ tokenHash: TOKEN, note: "next", version }), null, clock.now());
    expect(at(4)).toEqual({ kind: "refuse", reason: "stale_version" });
    expect(at(5)).toEqual({ kind: "apply", state: "claimed" });
  });
});

test("a list runs from what can be picked up to what cannot", () => {
  const clock = new Clock();
  const made = (id: string, state: Task["state"], minutes: number, lease: TaskLease | null) => {
    const at = new Date(clock.now().getTime() + minutes * 60_000);
    return { id, state, lease, createdAt: at, updatedAt: at };
  };
  const lapsing = { ...leaseAt(clock), expiresAt: clock.now() };
  const tasks = [
    made("finished", "done", 9, null),
    made("held", "claimed", 8, leaseAt(clock)),
    made("open-newer", "open", 7, null),
    made("open-older", "open", 1, null),
    made("lapsed", "claimed", 5, lapsing),
    made("handed-older", "handed_off", 2, null),
    made("handed-newer", "handed_off", 6, null),
  ];
  expect(inPickUpOrder(tasks, clock.now()).map((entry) => entry.id)).toEqual([
    "handed-newer",
    "handed-older",
    "lapsed",
    "open-older",
    "open-newer",
    "held",
    "finished",
  ]);
});
