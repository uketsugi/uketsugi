/**
 * What a case plans and does, pinned without a session: D5's reversal is said whether or not T8
 * passed (the plant has to be said, or no product could recall it), and a later round of an arm is
 * numbered on from the earlier one, with its control left out.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { loadChain, type ChainData } from "../../src/recall/chain.ts";
import { loadItems, type Items } from "../../src/recall/items.ts";
import { caseSessions, sessionCount } from "../../src/recall/plan.ts";
import { steps, type Running } from "../../src/recall/runner.ts";
import { jobsOf, type RunOptions } from "../../src/recall/suite.ts";

vi.mock("../../src/recall/judge.ts", () => ({
  judge: () => Promise.resolve({ passed: false, tests: {}, tail: "" }),
}));

let chain: ChainData;
let items: Items;
let root = "";

beforeAll(async () => {
  chain = await loadChain();
  items = await loadItems();
  root = mkdtempSync(join(tmpdir(), "recall-check-plan-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("D5's plant", () => {
  test("works T6, resets to T8's parent, works T8, and then says the reversal", () => {
    const plant = caseSessions(items["D5"] as never, chain, "quick", 2, false)[0];
    const kinds = plant?.steps.map((s) => Object.keys(s)[0]);

    expect(kinds).toEqual(["task", "reset", "task", "say_after_task"]);
    expect(JSON.stringify(plant?.steps.at(-1))).toContain("90 days");
  });

  test("is said when T8 has not passed after every follow-up", async () => {
    const prompts: string[] = [];
    const run = {
      c: {
        dir: root,
        stepOf: () => 0,
        session: (o: { prompt: string }) => {
          prompts.push(o.prompt);
          return Promise.resolve({ code: 0, killed: false, firstWrite: null, sessionId: "s1" });
        },
      },
      suite: {
        adapter: { session: () => ({}) },
        chain: { tasks: { T8: { prompt: "do T8" } }, maxFollowups: 1, followup: "try again" },
        judge: {},
      },
      plan: {
        id: "S1",
        steps: [{ task: "T8" }, { say_after_task: "make 90 and 14 the defaults" }],
      },
      config: "activate",
      tree: root,
      baseline: undefined,
      ident: null,
      setup: undefined,
    } as unknown as Running;

    await steps(run);

    expect(prompts).toEqual(["do T8", "try again", "make 90 and 14 the defaults"]);
  });
});

describe("rounds of an arm", () => {
  const base: RunOptions = {
    adapter: {} as never,
    configs: ["activate"],
    items: ["D1", "D12"],
    mode: "quick",
    gap: 2,
    repeat: 2,
    repeatFrom: 3,
    control: false,
    jobs: 1,
    out: "",
  };

  test("number their treatments on from the first unused repeat, and the control stays repeat 0", () => {
    const jobs = jobsOf({ ...base, control: true });

    expect(jobs.filter((j) => j.kind === "treatment").map((j) => j.repeat)).toEqual([3, 3, 4, 4]);
    expect(jobs.filter((j) => j.kind === "control").map((j) => j.repeat)).toEqual([0, 0]);
  });

  test("leave out the control when told, and the planned sessions agree", () => {
    expect(jobsOf(base).every((j) => j.kind === "treatment")).toBe(true);
    const names = base.items;
    expect(sessionCount(items, chain, names, 2, 2, true)).toBeGreaterThan(
      sessionCount(items, chain, names, 2, 2, false),
    );
  });
});
