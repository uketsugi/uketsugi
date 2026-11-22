/** Calibration's decisions, from trials a stand-in runs: the machine's K, the provider's K, and `width.json`. */
import { describe, expect, test } from "vitest";
import { machineWidth, providerWidth, widthOf, type MachineTrial } from "../../src/live/width.ts";

const trial = (k: number, over: Partial<MachineTrial> = {}): MachineTrial => ({
  k,
  allPassed: true,
  serversUp: true,
  ratio: 1.1,
  ...over,
});

const MAX_RATIO_PRINTED = 1.25;

describe("the machine's K", () => {
  test("is the widest of 8, 16, 24 and 32 at which every judgement passed and every server stayed up in every one of three repeats, whatever the times", async () => {
    const asked: string[] = [];
    const found = await machineWidth((k, repeat) => {
      asked.push(`${k}.${repeat}`);
      return Promise.resolve(trial(k, { ratio: k * 3 }));
    });
    expect(found.k).toBe(32);
    expect(asked).toHaveLength(12);
    expect(found.trials.every((t) => t.ratio > MAX_RATIO_PRINTED)).toBe(true);
  });

  test("a repeat that fails at a K ends the search there: the K before it is the width", async () => {
    const asked: string[] = [];
    const found = await machineWidth((k, repeat) => {
      asked.push(`${k}.${repeat}`);
      return Promise.resolve(trial(k, k === 24 && repeat === 2 ? { allPassed: false } : {}));
    });
    expect(found.k).toBe(16);
    expect(asked.slice(-4)).toEqual(
      ["24.0", "24.1", "24.2"].slice(-3).length ? ["16.2", "24.0", "24.1", "24.2"] : [],
    );
    expect(asked).toHaveLength(9);
  });

  test("a failed judgement or a server that went down ends it, and it stops at that repeat", async () => {
    expect(
      (await machineWidth((k) => Promise.resolve(trial(k, k === 16 ? { serversUp: false } : {}))))
        .k,
    ).toBe(8);
    expect((await machineWidth((k) => Promise.resolve(trial(k, { allPassed: false })))).k).toBe(0);
    let calls = 0;
    await machineWidth((k) => {
      calls += 1;
      return Promise.resolve(trial(k, { allPassed: false }));
    });
    expect(calls).toBe(1);
  });

  test("the kept calibration (one trial a K, all held, times 1.8 to 36 times solo) gives the machine's K 32 when a repeat is one, and W 16 with the provider's 16", () => {
    const kept = [8, 16, 24, 32].map((k) =>
      trial(k, { ratio: [1.85, 7.12, 35.77, 4.32][k / 8 - 1] as number }),
    );
    let at = 0;
    return machineWidth(() => Promise.resolve(kept[Math.floor(at++)] as MachineTrial), 1).then(
      (m) => {
        expect(widthOf(m, { k: 16, tries: [] })).toMatchObject({ width: 16, units: 4 });
      },
    );
  });
});

describe("the provider's K", () => {
  test("halves after a refusal until a run is clean", async () => {
    const asked: number[] = [];
    const found = await providerWidth(16, (k) => {
      asked.push(k);
      return Promise.resolve({ refused: k > 4 });
    });
    expect(found.k).toBe(4);
    expect(asked).toEqual([16, 8, 4]);
  });

  test("is 0 when even one session is refused", async () => {
    expect((await providerWidth(2, () => Promise.resolve({ refused: true }))).k).toBe(0);
  });
});

describe("width.json", () => {
  test("holds both widths, the narrower as W, and N = floor(W / 4)", () => {
    expect(widthOf({ k: 24, trials: [] }, { k: 10, tries: [] })).toMatchObject({
      width: 10,
      units: 2,
    });
    expect(widthOf({ k: 8, trials: [] }, { k: 10, tries: [] })).toMatchObject({
      width: 8,
      units: 2,
    });
  });
});
