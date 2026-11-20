/**
 * The suite's temporary workspace: `<tmpdir>/ukt-recall-<pid>-<random>/`, which holds everything a run
 * clones, builds and copies, and is gone when the run is, whatever ended it. A run killed with
 * SIGKILL leaves its folder; the next start removes every workspace whose pid is dead.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { killAll } from "./process.ts";

const PREFIX = "ukt-recall-";

export class Workspace {
  readonly path: string;

  private constructor(path: string) {
    this.path = path;
  }

  static async create(): Promise<Workspace> {
    await sweepStale();
    const path = await mkdtemp(join(tmpdir(), `${PREFIX}${process.pid}-`));
    await writeFile(join(path, "pid"), String(process.pid));
    return new Workspace(path);
  }

  at(...parts: string[]): string {
    return join(this.path, ...parts);
  }

  async make(...parts: string[]): Promise<string> {
    const path = this.at(...parts);
    await mkdir(path, { recursive: true });
    return path;
  }

  /** Stops every child, then removes the folder. */
  async close(): Promise<void> {
    killAll();
    await removeTree(this.path);
  }
}

/** Go leaves read-only folders in its module and build caches: they are made writable first. */
export async function removeTree(path: string): Promise<void> {
  await promisify(execFile)("chmod", ["-R", "u+w", path]).catch(() => undefined);
  await rm(path, { recursive: true, force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes the workspaces of runs that no longer exist; returns their names. */
export async function sweepStale(): Promise<string[]> {
  const swept: string[] = [];
  for (const name of await readdir(tmpdir())) {
    const match = new RegExp(`^${PREFIX}(\\d+)-`).exec(name);
    if (match?.[1] === undefined || alive(Number(match[1]))) continue;
    await removeTree(join(tmpdir(), name));
    swept.push(name);
  }
  return swept;
}
