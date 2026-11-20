/**
 * The workspace leaves nothing behind. The command is started as a person starts it, and stopped at
 * a stage where it holds a clone or a judgement: a wrapper `git` or `bwrap` that sleeps stands in for
 * a slow one, so the signal arrives while the child is running. Afterwards no process of the run and no
 * workspace folder is left; after SIGKILL the children go at once (setpriv's death signal) and the
 * next start removes the folder.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eventually } from "@uketsugi/testkit";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

const PACKAGE = fileURLToPath(new URL("../..", import.meta.url));
const ERGO_ORIGIN = "https://github.com/ergochat/ergo.git";

let root = "";
let ergo = "";

/** Marks the sleeping stand-ins so that `pgrep` can find them and nothing else. */
const MARK = { clone: "313.31", judge: "313.32" };

function wrappers(): string {
  const dir = join(root, "bin");
  mkdirSync(dir, { recursive: true });
  const script = (name: string, pattern: string, mark: string): void => {
    const path = join(dir, name);
    writeFileSync(
      path,
      `#!/bin/sh\ncase "$*" in *${pattern}*) exec sleep ${mark};; esac\nexec ${execFileSync("which", [name]).toString().trim()} "$@"\n`,
    );
    chmodSync(path, 0o755);
  };
  script("git", "clone*github.com*", MARK.clone);
  script("bwrap", "--unshare-pid", MARK.judge);
  return dir;
}

interface Running {
  child: ChildProcess;
  tmp: string;
  output: () => string;
  ended: Promise<number | null>;
}

function startCommand(tmp: string, source: string): Running {
  mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, TMPDIR: tmp, PATH: `${join(root, "bin")}:${process.env["PATH"]}` };
  const child = spawn(
    "node",
    [
      "--conditions=@uketsugi/source",
      "src/recall/cli.ts",
      "--prepare-only",
      "--ergo",
      source,
      "--out",
      join(tmp, "out"),
    ],
    { cwd: PACKAGE, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let text = "";
  child.stdout?.on("data", (d: Buffer) => (text += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (text += d.toString()));
  const ended = new Promise<number | null>((resolve) =>
    child.once("close", (code) => resolve(code)),
  );
  return { child, tmp, output: () => text, ended };
}

const sleeping = (mark: string): number => {
  try {
    return execFileSync("pgrep", ["-f", `sleep ${mark}`])
      .toString()
      .trim()
      .split("\n").length;
  } catch {
    return 0;
  }
};

/** Waits for a state, giving up only at the hang guard (testkit's `eventually`). */
const until = (condition: () => boolean): Promise<void> =>
  eventually(() => {
    expect(condition()).toBe(true);
  });

const workspaces = (tmp: string): string[] =>
  readdirSync(tmp).filter((n) => n.startsWith("ukt-recall-") && !n.includes("results"));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "recall-check-workspace-"));
  wrappers();
  ergo = process.env["UKT_RECALL_ERGO"] ?? join(root, "ergo");
  if (!existsSync(ergo))
    execFileSync("git", ["clone", "-q", "--no-checkout", ERGO_ORIGIN, ergo], { stdio: "inherit" });
});

/** Whatever a test, broken or not, left running: the stand-ins this file started, found by their marks. */
afterEach(() => {
  for (const mark of Object.values(MARK)) {
    try {
      for (const pid of execFileSync("pgrep", ["-f", `sleep ${mark}`])
        .toString()
        .split("\n")) {
        if (pid !== "") process.kill(Number(pid), "SIGKILL");
      }
    } catch {
      // none running
    }
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the workspace and its children are gone when the command is stopped", () => {
  test.each(["SIGINT", "SIGTERM"] as const)("%s during the clone", async (signal) => {
    const run = startCommand(join(root, `clone-${signal}`), ERGO_ORIGIN);
    await until(() => sleeping(MARK.clone) > 0);
    run.child.kill(signal);
    await run.ended;

    expect(sleeping(MARK.clone)).toBe(0);
    expect(workspaces(run.tmp)).toEqual([]);
  });

  test.each(["SIGINT", "SIGTERM"] as const)("%s during judging", async (signal) => {
    const run = startCommand(join(root, `judge-${signal}`), ergo);
    await until(() => sleeping(MARK.judge) > 0);
    run.child.kill(signal);
    await run.ended;

    expect(sleeping(MARK.judge)).toBe(0);
    expect(workspaces(run.tmp)).toEqual([]);
  });

  test("SIGKILL ends the children at once, and the next start removes the folder", async () => {
    const first = startCommand(join(root, "kill"), ergo);
    await until(() => sleeping(MARK.judge) > 0);
    first.child.kill("SIGKILL");
    await first.ended;
    await until(() => sleeping(MARK.judge) === 0);
    const left = workspaces(first.tmp);

    expect(left).toHaveLength(1);

    const second = startCommand(first.tmp, ergo);
    await until(() => !left.every((name) => workspaces(first.tmp).includes(name)));
    await until(() => sleeping(MARK.judge) > 0);
    second.child.kill("SIGTERM");
    await second.ended;

    expect(workspaces(first.tmp)).toEqual([]);
  });
});
