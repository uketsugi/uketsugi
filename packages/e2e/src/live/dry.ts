/**
 * The dry run: the real run with no tokens. Everything is real (set-up, the release, trees, homes
 * and stores, the real judge and the real server with its model, the stop that waits, the copies)
 * except the harness: a stand-in `claude` that sleeps as long as it is told, applies the task's
 * reference patch so that the judge passes, and writes a memory note into the home. What it
 * measures is the schedule's own work, between sessions and around them, on this machine at the
 * width a run uses; the sessions' times are given (`--durations`, seconds, scaled by `--scale`).
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA } from "../recall/chain.ts";
import type { Job } from "./pair.ts";

/** Seconds a session takes, by arm; a unit takes the entry its number picks (cycling). */
export interface DryDurations {
  readonly E: Record<"memory" | "none", readonly (readonly [number, number])[]>;
  readonly L: Record<"memory" | "none", Record<"T4" | "T8", readonly number[]>>;
}

export interface Dry {
  readonly durations: DryDurations;
  readonly scale: number;
  /** What the stand-in earlier session of the memory arm stores, by the product's own write path: facts of a real session's store's size, so that the carried store is not empty and the server's stop has something to flush. */
  readonly facts?: readonly Record<string, unknown>[];
}

const TASK_PATCH: Record<string, string> = { T1: "0001", T2: "0002", T4: "0004", T8: "0008" };

export const STAND_IN = `#!/bin/sh
# A stand-in for claude in the dry run: it never calls a model.
case "$1" in
  --version) echo "2.1.329 (dry-run stand-in)"; exit 0;;
  mcp) mkdir -p "$HOME"; echo '{"mcpServers":{"uketsugi":{"type":"http"}}}' > "$HOME/.claude.json"; exit 0;;
esac
prompt="$2"
task=""
case "$prompt" in
  /mcp__uketsugi__setup*)
    mkdir -p "$HOME/.claude"; echo "# the product's block (dry run)" >> "$HOME/.claude/CLAUDE.md"; sleep 2;;
  *"welcome people"*) task=T1;;
  *"private notes"*) task=T2;;
  *"stop a founder from changing"*) task=T4;;
  *"join bots"*) task=T8;;
esac
if [ -n "$task" ]; then
  secs=$(grep -o "$task=[0-9]*" "$HOME/.dry" | head -1 | cut -d= -f2)
  sleep "\${secs:-1}"
  (cd /home/demo/work && git apply "$HOME/.dry.$task.patch")
  mkdir -p "$HOME/.claude/projects/-home-demo-work/memory"
  echo "dry run note for $task" >> "$HOME/.claude/projects/-home-demo-work/memory/note.md"
fi
echo '{"type":"result","is_error":false,"result":"dry run"}'
`;

const pick = <T>(list: readonly T[], unit: number): T => list[(unit - 1) % list.length] as T;

/** Writes what the stand-in reads into the home the session is about to be copied from: its times, and the patches of its tasks. */
export async function prepareDryHome(dry: Dry, job: Job, home: string): Promise<void> {
  const tasks: [string, number][] =
    job.task === undefined
      ? (() => {
          const [t1, t2] = pick(dry.durations.E[job.arm], job.unit);
          return [
            ["T1", t1],
            ["T2", t2],
          ];
        })()
      : [[job.task, pick(dry.durations.L[job.arm][job.task], job.unit)]];
  await writeFile(
    join(home, ".dry"),
    tasks.map(([t, s]) => `${t}=${Math.max(1, Math.round(s * dry.scale))}`).join(" ") + "\n",
  );
  const patches = await readdir(join(DATA, "reference"));
  for (const [task] of tasks) {
    const file = patches.find((p) => p.startsWith(`${TASK_PATCH[task]}-`)) as string;
    await writeFile(
      join(home, `.dry.${task}.patch`),
      await readFile(join(DATA, "reference", file)),
    );
  }
}
