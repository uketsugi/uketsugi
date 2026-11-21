/**
 * What one case does, as data. A case is one item. Its treatment is: the **plant** (a session on the
 * task, or tasks, where the item is first met), `gap` sessions on tasks that need none of the item (each
 * on its own reference tree; only the memory store is shared), then one **probe** per later task that
 * needs the item, each from its own copy of the store as the gap left it, on the reference code before
 * its task. Its control is the same without the plant, probing only the item's first needing task, three
 * draws: it must score 0. The chain file written beside a case's evidence has the same shape as the
 * Python suite's, so that either suite's evidence can be scored by either.
 */
import type { ChainData } from "./chain.ts";
import { needs, probeTasks, type Item, type Items } from "./items.ts";

export const CONTROL_DRAWS = 3;
export const DEFAULT_GAP = 2;

export type PlanStep = { task: string } | { reset: string } | { say_after_task: string };

export interface SessionPlan {
  id: string;
  harness: "claude";
  steps: PlanStep[];
  role: "plant" | "gap" | "probe";
  /** A probe's own copy of the store as the first probe found it. */
  restore_store_from?: string;
  /** Quick mode: the session ends at its first write to the tree. */
  kill_after?: "write";
}

/** The plant session's steps: the tasks where the item is met, a reset to each later one's parent, and the words said after a task, whether or not it passed: a plant has to be said, or the item is not in the store and no product could recall it. */
export function plantSteps(item: Item, chain: ChainData): PlanStep[] {
  return item.plant.flatMap((task, n): PlanStep[] => {
    const say = chain.tasks[task]?.sayAfterTask;
    return [
      ...(n > 0 ? [{ reset: task }] : []),
      { task },
      ...(say === undefined ? [] : [{ say_after_task: say }]),
    ];
  });
}

export function caseSessions(
  item: Item,
  chain: ChainData,
  mode: string,
  gap: number,
  control: boolean,
): SessionPlan[] {
  const sessions: SessionPlan[] = [];
  const next = (): string => `S${sessions.length + 1}`;
  if (!control)
    sessions.push({ id: next(), harness: "claude", steps: plantSteps(item, chain), role: "plant" });
  for (const task of item.gap.slice(0, gap)) {
    sessions.push({ id: next(), harness: "claude", steps: [{ task }], role: "gap" });
  }
  const first = next();
  const probes = probeTasks(item);
  const wanted = control ? Array<string>(CONTROL_DRAWS).fill(probes[0] as string) : probes;
  for (const task of wanted) {
    sessions.push({
      id: next(),
      harness: "claude",
      steps: [{ task }],
      role: "probe",
      restore_store_from: first,
      ...(mode === "quick" || control ? { kill_after: "write" as const } : {}),
    });
  }
  return sessions;
}

/** Every task a plan works. */
export function tasksOf(sessions: readonly SessionPlan[]): string[] {
  const used = sessions.flatMap((s) =>
    s.steps.flatMap((x) => ("task" in x ? [x.task] : "reset" in x ? [x.reset] : [])),
  );
  return [...new Set(used)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** The chain file of a case: what a scorer needs of it beside its transcripts. */
export function caseChain(
  items: Items,
  chain: ChainData,
  name: string,
  mode: string,
  gap: number,
  control: boolean,
) {
  const item = items[name] as Item;
  const sessions = caseSessions(item, chain, mode, gap, control);
  const used = tasksOf(sessions);
  const probes = probeTasks(item);
  return {
    name: chain.name,
    env: chain.env,
    followup: chain.followup,
    max_followups: chain.maxFollowups,
    exclude: chain.exclude,
    tasks: Object.fromEntries(used.map((t) => [t, chain.tasks[t]])),
    sessions,
    needs: needs(items, used),
    items: {
      [name]: {
        kind: item.kind,
        tests: Object.fromEntries(
          probes.filter((t) => item.tests[t] !== undefined).map((t) => [t, item.tests[t]]),
        ),
      },
    },
  };
}

/** How many sessions a run will start: each treatment `repeat` times and, unless `control` is off, each item's control once. */
export function sessionCount(
  items: Items,
  chain: ChainData,
  names: readonly string[],
  gap: number,
  repeat: number,
  control: boolean,
): number {
  return names.reduce((total, n) => {
    const item = items[n] as Item;
    return (
      total +
      repeat * caseSessions(item, chain, "quick", gap, false).length +
      (control ? caseSessions(item, chain, "quick", gap, true).length : 0)
    );
  }, 0);
}
