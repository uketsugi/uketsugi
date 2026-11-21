/** Pooling and the regression flag: runs pool when their frozen manifests hash alike; each claim is made once. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  freeze,
  harnessMinor,
  manifestOf,
  poolSection,
  regression,
  type ScoredRun,
} from "../../src/live/pool.ts";
import { scoreRun } from "../../src/live/score.ts";
import { SCORING, writeRun, type UnitSpec } from "./live-world.ts";

let root = "";
beforeAll(() => (root = mkdtempSync(join(tmpdir(), "recall-check-live-pool-"))));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const good: UnitSpec = {
  memory: {
    stored: ["D1", "D2", "P1"],
    found: { T4: ["D1", "D2"], T8: ["P1"] },
    passed: { T4: ["D1", "D2"], T8: ["P1"] },
    taskPasses: { T4: true, T8: true },
    tokens: { T4: 1e6, T8: 1e6 },
  },
  none: { tokens: { T4: 2e6, T8: 2e6 } },
};
const bad: UnitSpec = { memory: { stored: [] }, none: { tokens: { T4: 2e6, T8: 2e6 } } };

async function runOf(
  name: string,
  hash: string,
  spec: UnitSpec,
  units = 8,
  build = "x",
): Promise<ScoredRun> {
  const folder = join(root, name);
  mkdirSync(folder);
  writeRun(
    folder,
    Array.from({ length: units }, () => spec),
    hash,
    build,
  );
  return scoreRun(folder, SCORING);
}

describe("the frozen manifest", () => {
  test("the hash holds while the inputs hold, and changes with a file, the configuration, the model or the harness's minor version", async () => {
    const data = join(root, "data", "chain");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "chain.json"), '{"a":1}');
    const input = {
      folders: [data],
      config: "setup",
      model: "haiku",
      harness: "2.1.143 (Claude Code)",
    };
    const first = await manifestOf(input);
    expect((await manifestOf(input)).hash).toBe(first.hash);
    expect((await manifestOf({ ...input, harness: "2.1.200" })).hash).toBe(first.hash);
    expect((await manifestOf({ ...input, harness: "2.2.0" })).hash).not.toBe(first.hash);
    expect((await manifestOf({ ...input, config: "activate" })).hash).not.toBe(first.hash);
    expect((await manifestOf({ ...input, model: "sonnet" })).hash).not.toBe(first.hash);
    writeFileSync(join(data, "chain.json"), '{"a":2}');
    expect((await manifestOf(input)).hash).not.toBe(first.hash);
    expect(harnessMinor("2.1.143 (Claude Code)")).toBe("2.1");
  });

  test("is written to the run's folder before any session", async () => {
    const folder = join(root, "frozen");
    mkdirSync(folder);
    const hash = await freeze(folder, {
      folders: [],
      config: "setup",
      model: "haiku",
      harness: "2.1.0",
    });
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("pooled runs", () => {
  test("two runs with one hash pool, and the item claim is made once, at 16 units, by the run that completes them", async () => {
    const a = await runOf("A", "h1", good);
    const b = await runOf("B", "h1", good);
    const alone = poolSection(a, []);
    expect(alone).toContain("8 units pooled");
    expect(alone).toContain("Item and task claim: 8 of 16 pooled units; not made yet.");
    const pooled = poolSection(b, [a]);
    expect(pooled).toContain("2 runs, 16 units pooled");
    expect(pooled).toMatch(
      /Item and task claim, made once at 16 pooled units \(completed by x\): deciding item tests memory-only 48, none-only 0, p 0\.000/,
    );
    expect(pooled).toContain("Cost claim: 16 of 32 pooled units; not made yet.");
  });

  test("a void run does not pool, and the pooled result says which was left out and why", async () => {
    const a = await runOf("A4", "h1", good);
    const noModel = await runOf("V4", "h1", { ...good, memory: { ...good.memory, model: false } });
    const b = await runOf("B4", "h1", good);
    const text = poolSection(b, [a, noModel]);
    expect(text).toContain("2 runs, 16 units pooled");
    expect(text).toMatch(/Left out, void: x \(a memory-arm server did not show its model loaded/);
    const self = poolSection(noModel, [a]);
    expect(self).toMatch(/This run is void \(.*\) and is not pooled\./);
    expect(self).toContain("1 runs, 8 units pooled");
  });

  test("runs of different builds do not pool for the claims, and the flag still compares them and names the builds", async () => {
    const a = await runOf("A5", "h1", good, 8, "build-a");
    const b = await runOf("B5", "h1", good, 8, "build-b");
    const text = poolSection(b, [a]);
    expect(text).toContain("1 runs, 8 units pooled; build build-b.");
    expect(text).toContain("Not pooled for the claims: build-a is another build than build-b");
    expect(text).toContain("Item and task claim: 8 of 16 pooled units; not made yet.");
    expect(text).toContain("Regression flag against builds build-a");
  });

  test("a run with a changed manifest does not pool, and is listed as not pooled", async () => {
    const a = await runOf("A2", "h1", good);
    const c = await runOf("C2", "h2", good);
    const text = poolSection(c, [a]);
    expect(text).toContain("1 runs, 8 units pooled");
    expect(text).toContain("Not pooled: x has manifest h1.");
  });

  test("the cost claim is made at 32 pooled units", async () => {
    const runs = await Promise.all([1, 2, 3].map((n) => runOf(`K${n}`, "h1", good)));
    const last = await runOf("K4", "h1", good);
    const text = poolSection(last, runs);
    expect(text).toMatch(
      /Cost claim, made once at 32 pooled units \(completed by x\): later sessions 1000000 vs 2000000 tokens, exact Wilcoxon p 0\.\d+/,
    );
  });

  test("each run is flagged against the pool before it: a fall is a regression, an equal run is not, and none before is said", async () => {
    const a = await runOf("A3", "h1", good);
    const worse = await runOf("B3", "h1", bad);
    const same = await runOf("C3", "h1", good);
    expect(regression(a, [])).toBe("Regression flag: no pool before this run.");
    expect(regression(worse, [a])).toContain(
      "deciding tests with memory 0/24 against the pool's 24/24",
    );
    expect(regression(worse, [a])).toContain("REGRESSION");
    expect(regression(same, [a])).toContain("no flag");
    expect(regression(same, [a])).toContain("counted as independent");
  });
});
