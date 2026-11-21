/**
 * The pair shape, with a stand-in host and a clock the test turns: one unit is E (T1, a reset, T2)
 * and then L (T4 and T8, each on a copy of E's store and home), in both arms; a unit's L starts as
 * soon as its own E has ended and its server has stopped; nothing starts after minute 30; no
 * session runs longer than 22 minutes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { End } from "../../src/recall/ending.ts";
import { Guard } from "../../src/recall/quota.ts";
import { MINUTE, runPairs, type Host, type Job, type Outcome } from "../../src/live/pair.ts";

let work = "";
beforeEach(() => (work = mkdtempSync(join(tmpdir(), "recall-check-pair-"))));
afterEach(() => rmSync(work, { recursive: true, force: true }));

interface Pending {
  readonly job: Job;
  finish(outcome?: Partial<Outcome>): void;
}

/** A host whose sessions end when the test says: it logs every start and end, and what each saw on disk. */
class StandIn implements Host {
  clock = 0;
  readonly log: string[] = [];
  readonly caps: number[] = [];
  readonly seen: Record<string, string[]> = {};
  private readonly waiting = new Map<string, Pending>();
  private readonly changed: (() => void)[] = [];

  now = (): number => this.clock;

  tree(task: string, dest: string): Promise<void> {
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "README"), `reference before ${task}`);
    return Promise.resolve();
  }

  earlier(job: Job): Promise<Outcome> {
    // E writes what the later sessions are to carry: the home's harness memory, the store, the instruction files.
    mkdirSync(join(job.dirs.home, ".claude"), { recursive: true });
    writeFileSync(join(job.dirs.home, ".claude", "memory.md"), `unit ${job.unit} ${job.arm}`);
    mkdirSync(job.dirs.data, { recursive: true });
    writeFileSync(join(job.dirs.data, "store"), `store of ${job.unit} ${job.arm}`);
    writeFileSync(join(job.dirs.tree, "CLAUDE.md"), `rules ${job.unit} ${job.arm}`);
    writeFileSync(join(job.dirs.tree, "AGENTS.md"), "agents");
    return this.session(job);
  }

  later(job: Job): Promise<Outcome> {
    this.seen[this.key(job)] = [
      readFileSync(join(job.dirs.home, ".claude", "memory.md"), "utf8"),
      readFileSync(join(job.dirs.data, "store"), "utf8"),
      readFileSync(join(job.dirs.tree, "CLAUDE.md"), "utf8"),
      readFileSync(join(job.dirs.tree, "README"), "utf8"),
      existsSync(join(job.dirs.tree, "AGENTS.md")) ? "AGENTS.md" : "",
    ];
    return this.session(job);
  }

  private key = (job: Job): string => `${job.unit}${job.arm[0]}${job.task ?? "E"}`;

  private session(job: Job): Promise<Outcome> {
    this.log.push(`start ${this.key(job)} at ${this.clock / MINUTE}`);
    this.caps.push(job.capMs);
    return new Promise((resolve) => {
      this.waiting.set(this.key(job), {
        job,
        finish: (outcome) => {
          this.log.push(`end ${this.key(job)}`);
          resolve({ end: { kind: "done" }, readings: "", ...outcome });
        },
      });
      for (const note of this.changed.splice(0)) note();
    });
  }

  /** Ends a session and lets what it unblocks run. */
  async end(key: string, at: number, outcome?: Partial<Outcome>): Promise<void> {
    this.clock = at * MINUTE;
    (this.waiting.get(key) as Pending).finish(outcome);
    this.waiting.delete(key);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  started = (key: string): boolean => this.log.some((l) => l.startsWith(`start ${key} `));
}

const guard = (): Guard => new Guard({ utilization: 0.5, ok: true });
const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 20));

describe("the pair shape", () => {
  test("E starts first in both arms, then each L on copies of E's home, store and instruction files, on a fresh reference tree", async () => {
    const host = new StandIn();
    const run = runPairs({ units: 1, host, guard: guard(), work });
    await settle();
    expect(host.log).toEqual(["start 1mE at 0", "start 1nE at 0"]);
    await host.end("1mE", 10);
    await host.end("1nE", 11);
    const started = host.log.filter((l) => l.startsWith("start")).map((l) => l.split(" ")[1]);
    expect(started.slice(0, 2)).toEqual(["1mE", "1nE"]);
    expect(started.slice(2).sort()).toEqual(["1mT4", "1mT8", "1nT4", "1nT8"]);
    for (const key of ["1mT4", "1mT8", "1nT4", "1nT8"]) await host.end(key, 20);
    const units = await run;
    expect(host.seen["1mT4"]).toEqual([
      "unit 1 memory",
      "store of 1 memory",
      "rules 1 memory",
      "reference before T4",
      "AGENTS.md",
    ]);
    expect(host.seen["1nT8"]).toEqual([
      "unit 1 none",
      "store of 1 none",
      "rules 1 none",
      "reference before T8",
      "AGENTS.md",
    ]);
    expect(units).toHaveLength(1);
    expect(units[0]?.void).toBe(false);
    expect(units[0]?.arms.memory.carried.instructions).toEqual(["CLAUDE.md", "AGENTS.md"]);
  });

  test("one unit's L starts while another unit's E still runs: no barrier", async () => {
    const host = new StandIn();
    const run = runPairs({ units: 2, host, guard: guard(), work });
    await settle();
    await host.end("1mE", 9);
    expect(host.started("1mT4")).toBe(true);
    expect(host.started("2mE")).toBe(true);
    expect(host.log.includes("end 2mE")).toBe(false);
    expect(host.started("2mT4")).toBe(false);
    for (const key of ["1nE", "2mE", "2nE"]) await host.end(key, 12);
    for (const key of ["1mT4", "1mT8", "1nT4", "1nT8", "2mT4", "2mT8", "2nT4", "2nT8"])
      await host.end(key, 20);
    await run;
  });

  test("a session is capped 22 minutes after it starts, and none starts after minute 30", async () => {
    const host = new StandIn();
    const run = runPairs({ units: 1, host, guard: guard(), work });
    await settle();
    expect(host.caps).toEqual([22 * MINUTE, 22 * MINUTE]);
    const capped: Partial<Outcome> = { end: { kind: "capped", seconds: 1320 } };
    await host.end("1mE", 22, capped);
    await host.end("1nE", 31, capped);
    expect(host.started("1mT4")).toBe(true);
    expect(host.started("1nT4")).toBe(false);
    for (const key of ["1mT4", "1mT8"]) await host.end(key, 40);
    const [unit] = await run;
    expect(unit?.arms.none.later.T4?.end).toMatchObject({ kind: "void", cause: "clock" });
    expect(unit?.void).toBe(true);
  });

  test("a void earlier session starts none of its later sessions, though the window has room", async () => {
    const host = new StandIn();
    const run = runPairs({ units: 1, host, guard: guard(), work });
    await settle();
    await host.end("1mE", 5, { end: { kind: "void", cause: "provider", detail: "HTTP 529" } });
    await host.end("1nE", 6);
    expect(host.started("1mT4")).toBe(false);
    expect(host.started("1mT8")).toBe(false);
    for (const key of ["1nT4", "1nT8"]) await host.end(key, 10);
    const [unit] = await run;
    expect(unit?.arms.memory.later.T4?.end).toMatchObject({ kind: "void", cause: "provider" });
    expect(unit?.arms.memory.later.T4?.startedMs).toBeNull();
  });

  test("a void session makes its unit void in both arms, and no session starts once the window is near full", async () => {
    const host = new StandIn();
    const quota = new Guard({ utilization: 0.5, ok: true });
    const run = runPairs({ units: 2, host, guard: quota, work });
    await settle();
    const refused: End = { kind: "void", cause: "provider", detail: "HTTP 429" };
    await host.end("1mE", 5, {
      end: refused,
      readings:
        '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","utilization":0.95,"resetsAt":9999999999}}',
    });
    expect(host.started("1mT4")).toBe(false);
    await host.end("1nE", 6);
    await host.end("2mE", 7);
    await host.end("2nE", 7);
    expect(host.started("1nT4")).toBe(false);
    expect(host.started("2mT4")).toBe(false);
    const units = await run;
    expect(units.map((u) => u.void)).toEqual([true, true]);
    expect(units[1]?.arms.memory.later.T4?.end).toMatchObject({ kind: "void", cause: "quota" });
  });
});
