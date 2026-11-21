/**
 * A headline is over a fixed set of items. A treatment case that errors counts against its item (its
 * needed cells as misses), so that configurations that errored in different places are still figured
 * over the same cells; where that cannot be known, or the runs cover different items, the comparison
 * refuses and says why.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compare, headline } from "../../src/recall/report.ts";
import { rescore } from "../../src/recall/results.ts";
import { SCORING, errored, measured, resultOf } from "./world.ts";

describe("a treatment case that errored", () => {
  const run = resultOf([
    measured("W1", 2),
    errored("W2"),
    measured("W1", 0, 2, {}, "control"),
    measured("W2", 0, 2, {}, "control"),
  ]);

  test("counts its item's needed cells as misses, so the item stays in the figure", () => {
    const summary = run.recall["p/c"];

    expect(summary?.per_item).toEqual({ W1: [2, 2], W2: [0, 2] });
    expect(`${summary?.hits}/${summary?.cells}`).toBe("2/4");
  });

  test("is said in the headline as errored and counted", () => {
    expect(headline(run)).toMatch(/1 cases errored.*count as misses/);
  });

  test("leaves two configurations that errored in different places over the same cells", () => {
    const a = resultOf([measured("W1", 2), errored("W2")]);
    const b = resultOf([errored("W1"), measured("W2", 2)]);

    expect(a.recall["p/c"]?.cells).toBe(b.recall["p/c"]?.cells);
  });

  test("keeps a configuration whose every case errored in the result", () => {
    expect(resultOf([errored("W1"), errored("W2")]).recall["p/c"]?.cells).toBe(4);
  });

  test("cannot be counted when its record does not say how many cells were needed: the comparison refuses", () => {
    const legacy = resultOf([measured("W1", 2), errored("W2", { expected: undefined })]);
    const sound = resultOf([measured("W1", 2), measured("W2", 1)]);

    expect(legacy.recall["p/c"]?.unmeasured).toEqual(["W2"]);
    expect(compare(sound, legacy)).toMatch(/refused.*needed cells are not recorded/);
  });
});

describe("two runs over different items", () => {
  test("are not compared: the headlines are over different cells", () => {
    const both = resultOf([measured("W1", 1), measured("W2", 1)]);
    const one = resultOf([measured("W1", 1)]);

    expect(compare(both, one)).toMatch(/refused.*different items \(earlier: W1, W2; later: W1\)/);
  });

  test("over the same items, errors and all, are compared item by item", () => {
    const a = resultOf([measured("W1", 2), measured("W2", 2)]);
    const b = resultOf([measured("W1", 1), errored("W2")]);

    expect(compare(a, b)).toMatch(/recall p\/c: 4\/4 -> 1\/4 on 2 items/);
  });
});

describe("rescoring an earlier run", () => {
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "recall-check-itemset-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("records how many cells an errored case needed, which an old record did not say, and writes beside the evidence only where told", async () => {
    const folder = join(root, "old");
    const into = join(root, "scratch");
    mkdirSync(folder);
    mkdirSync(into);
    const old = resultOf([errored("W1", { expected: undefined })]);
    writeFileSync(join(folder, "result.json"), JSON.stringify(old));

    const result = await rescore(folder, SCORING, into);

    expect(result.cases[0]?.expected).toBe(2);
    expect(result.recall["p/c"]?.per_item).toEqual({ W1: [0, 2] });
    expect(existsSync(join(into, "result.rescored.json"))).toBe(true);
    expect(existsSync(join(folder, "result.rescored.json"))).toBe(false);
  });
});
