/**
 * Every child the suite starts, so that none outlives it. A child runs in a process group of its own
 * (killed whole: the harness, the shell and what it started) under `setpriv --pdeathsig KILL`, so a
 * suite killed with SIGKILL takes its direct children with it. `killAll` is what the exit handlers call.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const children = new Set<ChildProcess>();
let ending = false;

export interface Finished {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The absolute path of a program on this process's PATH, or undefined. */
export function resolveTool(name: string): string | undefined {
  for (const folder of (process.env["PATH"] ?? "").split(delimiter)) {
    try {
      accessSync(join(folder, name), constants.X_OK);
      return join(folder, name);
    } catch {
      // not in this folder
    }
  }
  return undefined;
}

/** Starts `command` as a tracked child of its own group. */
export function start(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  if (ending) throw new Error("the run is ending: nothing more is started");
  const child = spawn(
    resolveTool("setpriv") ?? "setpriv",
    ["--pdeathsig", "KILL", command, ...args],
    {
      ...options,
      detached: true,
    },
  );
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

/** Runs `command` to its end. A non-zero exit is an error that carries the tail of the output. */
export async function run(
  command: string,
  args: readonly string[],
  options: SpawnOptions & { allowFailure?: boolean } = {},
): Promise<Finished> {
  const { allowFailure, ...spawnOptions } = options;
  const child = start(command, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
  const finished = await new Promise<Finished>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
      }),
    );
  });
  if (finished.code !== 0 && allowFailure !== true) {
    const tail = (finished.stdout + finished.stderr).slice(-600);
    throw new Error(
      `${command} ${args.join(" ").slice(0, 120)} failed (${finished.code}): ${tail}`,
    );
  }
  return finished;
}

/** How long `stop` waits for a child to go before it kills it: what a person's `ukt` is given (`STOP_SECONDS`). */
const STOP_WITHIN_MS = 10_000;

/**
 * Ends a child's whole group, and waits until the child has gone: for `withinMs`, and then kills it.
 * Says whether it had to kill it.
 */
export async function stop(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  withinMs = STOP_WITHIN_MS,
): Promise<{ killed: boolean }> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
    return { killed: false };
  const gone = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let killed = false;
  killGroup(child, signal);
  const timer = setTimeout(() => {
    killed = true;
    killGroup(child, "SIGKILL");
  }, withinMs);
  await gone;
  clearTimeout(timer);
  return { killed };
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
  } catch {
    // the group has gone already
  }
}

/** Kills every group still running, at once, and refuses to start another: a run that is ending goes no further. */
export function killAll(): void {
  ending = true;
  for (const child of children) killGroup(child, "SIGKILL");
}
