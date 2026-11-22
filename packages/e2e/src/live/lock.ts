/**
 * One live run at a time on this machine. The width a run uses is measured for a machine that is
 * the run's alone, and two runs into one `--out` folder destroy each other's evidence (the first
 * frozen run was two runs at once, sixteen earlier sessions side by side). A run takes the lock
 * before anything starts and holds it until it ends; a second run, or a calibration, refuses and
 * names the run that holds the machine. A lock whose process is dead is taken over, and says so.
 * A run's folder must be new or empty.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";

/** Fixed, not under TMPDIR: two runs with different scratch folders are still one machine. */
export const LOCK_FILE = "/tmp/ukt-live.lock";

interface Held {
  readonly pid: number;
  /** The process's start time (field 22 of /proc/<pid>/stat): a pid that has since been given to another process is not the run. */
  readonly startTime: string | null;
  readonly command: string;
  readonly out: string | null;
  readonly since: string;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** When the process began, in the kernel's ticks, or null where it cannot be read. */
export function startTimeOf(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** Whether the process that took the lock is still the one running under its pid. */
const holds = (held: Held): boolean =>
  alive(held.pid) && (held.startTime === null || startTimeOf(held.pid) === held.startTime);

const readHeld = async (path: string): Promise<Held | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Held;
  } catch {
    return undefined;
  }
};

/** Refuses a folder that already holds something: it is a run's (or any other) evidence. */
export async function refuseUsedFolder(out: string): Promise<void> {
  const names = await readdir(out).catch(() => [] as string[]);
  if (names.length > 0)
    throw new Error(
      `the output folder ${out} already holds ${names.length} entries (a run's evidence?): a run writes into a folder of its own, new or empty`,
    );
}

/**
 * Takes the machine for `command`. Returns what to call when the run ends. `out`, when the command
 * writes a folder, must be new or empty.
 */
export async function takeMachine(
  command: string,
  out: string | null,
  lockFile = LOCK_FILE,
): Promise<() => void> {
  if (out !== null) await refuseUsedFolder(out);
  const mine: Held = {
    pid: process.pid,
    startTime: startTimeOf(process.pid),
    command,
    out,
    since: new Date().toISOString(),
  };
  for (let tries = 0; ; tries++) {
    try {
      await writeFile(lockFile, JSON.stringify(mine), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const held = await readHeld(lockFile);
      if (held !== undefined && holds(held))
        throw new Error(
          `another live run holds this machine: \`${held.command}\` (pid ${held.pid}, since ${held.since}${held.out === null ? "" : `, writing ${held.out}`}); the width is measured for a machine that is one run's alone, so wait for it to end`,
          { cause: error },
        );
      if (tries > 3) throw new Error(`could not take the lock ${lockFile}`, { cause: error });
      console.log(
        `taking over a lock left by ${held === undefined ? "an unreadable lock file" : `a process that is gone (pid ${held.pid}, \`${held.command}\`)`}`,
      );
      await rm(lockFile, { force: true });
    }
  }
  const release = (): void => {
    try {
      unlinkSync(lockFile);
    } catch {
      // already gone
    }
  };
  process.once("exit", release);
  if (out !== null) await mkdir(out, { recursive: true });
  return release;
}
