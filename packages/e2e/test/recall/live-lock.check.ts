/** One live run at a time: a real second process is refused, a dead process's lock is taken over, and a run's folder must be new. */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { LOCK_FILE, refuseUsedFolder, startTimeOf, takeMachine } from "../../src/live/lock.ts";
import { liveRun } from "../../src/live/start.ts";

let root = "";
let lock = "";
const kids: ChildProcess[] = [];
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "recall-check-live-lock-"));
  lock = join(root, "lock");
});
afterAll(() => {
  for (const kid of kids) kid.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

/** A real process that takes the lock and holds it until killed. */
function holder(name: string, file: string): Promise<ChildProcess> {
  const script = join(root, `${name}.mjs`);
  writeFileSync(
    script,
    `import { takeMachine } from ${JSON.stringify(join(import.meta.dirname, "../../src/live/lock.ts"))};
await takeMachine("live --units 4 (the first run)", ${JSON.stringify(join(root, `${name}-out`))}, ${JSON.stringify(file)});
console.log("held");
setInterval(() => {}, 1000);
`,
  );
  const child = spawn("node", ["--conditions=@uketsugi/source", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  kids.push(child);
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (d: Buffer) => d.toString().includes("held") && resolve(child));
    child.once("exit", () => reject(new Error("the holder ended")));
  });
}

describe("one live run at a time", () => {
  test("a second run while one is running refuses, before anything, and names the run that holds the machine", async () => {
    const first = await holder("first", lock);
    const error = await takeMachine("live --calibrate", join(root, "second-out"), lock).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(error).toContain("another live run holds this machine");
    expect(error).toContain("live --units 4 (the first run)");
    expect(error).toContain(`pid ${first.pid}`);
    expect(existsSync(join(root, "second-out"))).toBe(false);
  }, 30_000);

  test("a lock left by a dead process is taken over, and says so", async () => {
    const file = join(root, "dead-lock");
    const dead = await holder("dead", file);
    dead.kill("SIGKILL");
    await new Promise((resolve) => dead.once("exit", resolve));
    const said = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const release = await takeMachine("live (run)", null, file);
      expect(said).toHaveBeenCalledWith(
        expect.stringContaining("taking over a lock left by a process that is gone"),
      );
      expect((JSON.parse(readFileSync(file, "utf8")) as { pid: number }).pid).toBe(process.pid);
      release();
      expect(existsSync(file)).toBe(false);
    } finally {
      said.mockRestore();
    }
  }, 30_000);

  test("the lock is released when the run ends, and the next run takes it", async () => {
    const file = join(root, "again");
    (await takeMachine("one", null, file))();
    (await takeMachine("two", null, file))();
    expect(existsSync(file)).toBe(false);
  });
});

describe("a run's folder", () => {
  test("must be new or empty: a folder that already holds a run is refused and nothing is written to it", async () => {
    const used = join(root, "used");
    mkdirSync(join(used, "cases"), { recursive: true });
    writeFileSync(join(used, "run.json"), "{}");
    await expect(takeMachine("live (run)", used, join(root, "l1"))).rejects.toThrow(
      /already holds 2 entries/,
    );
    expect(existsSync(join(root, "l1"))).toBe(false);
    mkdirSync(join(root, "empty"));
    (await takeMachine("live (run)", join(root, "empty"), join(root, "l2")))();
    await refuseUsedFolder(join(root, "nowhere"));
  });

  test("the run command refuses a folder that holds a run, before it sets anything up", async () => {
    const model = join(root, "model");
    mkdirSync(join(model, "node_modules"), { recursive: true });
    mkdirSync(join(model, "models"), { recursive: true });
    const earlier = join(root, "earlier-run");
    mkdirSync(join(earlier, "cases", "u1-memory-E", "transcripts"), { recursive: true });
    writeFileSync(
      join(earlier, "cases", "u1-memory-E", "transcripts", "E.0.jsonl"),
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          resetsAt: 99999999999,
          utilization: 0.1,
          isUsingOverage: false,
        },
      }) + "\n",
    );
    await expect(
      liveRun({ units: "1", "model-dir": model, "reading-from": earlier, out: earlier }),
    ).rejects.toThrow(/already holds/);
  });
});

describe("a lock whose pid belongs to another process now", () => {
  test("is taken over when the process under the pid is not the one that took it, and refused when it is", async () => {
    const other = spawn("sleep", ["300"], { stdio: "ignore" });
    kids.push(other);
    const file = join(root, "reused");
    const written = (startTime: string | null): void =>
      writeFileSync(
        file,
        JSON.stringify({
          pid: other.pid,
          startTime,
          command: "live (an old run)",
          out: null,
          since: "then",
        }),
      );
    written("1");
    const said = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      (await takeMachine("live (run)", null, file))();
      expect(said).toHaveBeenCalledWith(expect.stringContaining("a process that is gone"));
    } finally {
      said.mockRestore();
    }
    written(startTimeOf(other.pid as number));
    await expect(takeMachine("live (run)", null, file)).rejects.toThrow(
      /another live run holds this machine/,
    );
  });
});

describe("the lock is released however a run ends", () => {
  /** A process that takes the lock, then ends the way `how` says; the lock must be gone when it has. */
  async function endsBy(how: string): Promise<boolean> {
    const file = join(root, `ends-${how}`);
    const script = join(root, `ends-${how}.mjs`);
    writeFileSync(
      script,
      `import { takeMachine } from ${JSON.stringify(join(import.meta.dirname, "../../src/live/lock.ts"))};
const release = await takeMachine("live (run)", null, ${JSON.stringify(file)});
const how = ${JSON.stringify(how)};
// what a run installs: a handler that ends the process, so that its exit handlers run
process.once("SIGTERM", () => process.exit(143));
console.log("held");
if (how === "returns") { release(); }
else if (how === "throws") { throw new Error("the run failed"); }
else if (how === "exits") { process.exit(3); }
else setInterval(() => {}, 1000);
`,
    );
    const child = spawn("node", ["--conditions=@uketsugi/source", script], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    kids.push(child);
    const ended = new Promise((resolve) => child.once("exit", resolve));
    await new Promise<void>((resolve) =>
      child.stdout.on("data", (d: Buffer) => d.toString().includes("held") && resolve()),
    );
    if (how === "terminated") child.kill("SIGTERM");
    await ended;
    return existsSync(file);
  }

  for (const how of ["returns", "throws", "exits", "terminated"])
    test(`when it ${how}`, async () => {
      expect(await endsBy(how)).toBe(false);
    }, 30_000);

  test("when the run command fails after taking it", async () => {
    const model = join(root, "model-for-release");
    mkdirSync(join(model, "node_modules"), { recursive: true });
    mkdirSync(join(model, "models"), { recursive: true });
    const measured = join(root, "measured-for-release.json");
    const minute = 60_000;
    writeFileSync(
      measured,
      JSON.stringify({
        byUnits: [
          {
            units: 4,
            setupCachedMs: 3 * minute,
            setupBuiltMs: 3 * minute,
            eFinishMs: minute,
            gapMs: minute,
            judgeMs: minute,
            lFinishMs: minute,
            settleMs: 0,
            printMs: 1000,
          },
        ],
      }),
    );
    const reading = join(root, "reading-for-release");
    mkdirSync(join(reading, "cases", "u1-memory-E", "transcripts"), { recursive: true });
    writeFileSync(
      join(reading, "cases", "u1-memory-E", "transcripts", "E.0.jsonl"),
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          resetsAt: 99999999999,
          utilization: 0.1,
          isUsingOverage: false,
        },
      }) + "\n",
    );
    await expect(
      liveRun({
        units: "1",
        "model-dir": model,
        "reading-from": reading,
        measured,
        out: join(root, "fails-late"),
      }),
    ).rejects.toThrow(/--ergo/);
    expect(existsSync(LOCK_FILE)).toBe(false);
  }, 120_000);
});
