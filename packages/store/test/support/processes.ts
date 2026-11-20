/**
 * The processes the recovery's tests run: a writer that is killed, and `open.ts` under the
 * `hold-syncs.ts` preload, with what each says and the log the preload keeps.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { eventually } from "@uketsugi/testkit";

const HERE = import.meta.dirname;
const made: string[] = [];
const started: ChildProcess[] = [];

/** Stops what a test left running and removes what the copies and the openings made; call it after the tests. */
export async function removeMade(): Promise<void> {
  for (const child of started.splice(0)) child.kill("SIGKILL");
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
const SOURCE = "--conditions=@uketsugi/source";

/**
 * Runs the writer on `dataDir` until `kill(acknowledged)` says to stop it, then kills it with
 * SIGKILL, which leaves the engine's files as a power cut does. Gives back every fact id it
 * acknowledged.
 */
export async function writeUntilKilled(
  dataDir: string,
  kill: (acknowledged: readonly string[]) => boolean,
  onAcknowledged: (acknowledged: readonly string[]) => Promise<void> = () => Promise.resolve(),
): Promise<string[]> {
  const args = [SOURCE, join(HERE, "writer.ts"), dataDir, "1000"];
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
  const acknowledged: string[] = [];
  for await (const line of createInterface(child.stdout)) {
    acknowledged.push(line);
    await onAcknowledged(acknowledged);
    if (kill(acknowledged)) child.kill("SIGKILL");
  }
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  return acknowledged;
}

/** A copy of a data directory without its lock, whose owner is dead: what a test may start on. */
export async function copyOf(dataDir: string): Promise<string> {
  const copy = await mkdtemp(join(tmpdir(), "uketsugi-recovery-"));
  made.push(copy);
  await cp(dataDir, copy, { recursive: true });
  await Promise.all(
    ["lock", "lock.owner"].map((name) => rm(join(copy, name), { recursive: true, force: true })),
  );
  return copy;
}

/** A process that runs under the preload, held by a directory of its own. */
export interface Held {
  readonly child: ChildProcess;
  /** Each line it has printed. */
  readonly lines: string[];
  /** What it has printed as JSON, one object a line; a line that is not JSON is left out. */
  said(): Record<string, unknown>[];
  /** Resolves when the process has ended and all it printed is in `lines`. */
  readonly ended: Promise<void>;
  /** Whether it has ended. */
  readonly over: boolean;
  /** The preload's log, with the test's own lines in it, in the order they were written. */
  log(): string[];
  /** Lets every sync up to the nth go, and notes it in the log. */
  release(n: number): void;
  /** Writes a line of the test's own to the log. */
  mark(line: string): void;
}

/** Runs node on `args` under the recording preload; every thread's syncs are held with `holdAll`, a worker's alone otherwise. */
export async function held(args: string[], holdAll: boolean): Promise<Held> {
  const hold = await mkdtemp(join(tmpdir(), "uketsugi-hold-"));
  made.push(hold);
  const env = { ...process.env, HOLD_DIR: hold, ...(holdAll ? { HOLD_ALL: "1" } : {}) };
  const child = spawn(
    process.execPath,
    ["--import", join(HERE, "hold-syncs.ts"), SOURCE, ...args],
    {
      env,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  started.push(child);
  const lines: string[] = [];
  const reading = (async () => {
    for await (const line of createInterface(child.stdout)) lines.push(line);
  })();
  const state = { over: false };
  const ended = Promise.all([reading, once(child, "exit")]).then(() => {
    state.over = true;
  });
  return {
    child,
    lines,
    said: () =>
      lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      }),
    ended,
    get over() {
      return state.over;
    },
    log: () => {
      try {
        return readFileSync(join(hold, "log"), "utf8")
          .split("\n")
          .filter((line) => line !== "");
      } catch {
        return [];
      }
    },
    mark: (line) => appendFileSync(join(hold, "log"), `${line}\n`),
    release: (n) => {
      appendFileSync(join(hold, "log"), `release ${n}\n`);
      writeFileSync(join(hold, "released"), String(n));
    },
  };
}

/** Waits until the nth sync of some thread is held, or the process has ended, and says which thread holds it. */
export async function heldBy(run: Held, n: number): Promise<string | undefined> {
  const entry = (): string | undefined =>
    run.log().find((line) => line.endsWith(` ${n}`) && line.startsWith("sync"));
  await eventually(() => {
    if (!run.over && entry() === undefined) throw new Error(`sync ${n} is not held yet`);
  });
  return entry()?.split(" ")[1];
}

/** `open.ts` on a data directory. */
export const opening = (dataDir: string, holdAll = false): Promise<Held> =>
  held([join(HERE, "open.ts"), dataDir], holdAll);
