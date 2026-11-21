/** Calibration's decisions, from trials a stand-in runs: the machine's K, the provider's K, and `width.json`. */
import { describe, expect, test } from "vitest";
import {
  MAX_RATIO,
  machineWidth,
  providerWidth,
  widthOf,
  type MachineTrial,
} from "../../src/live/width.ts";

const trial = (k: number, over: Partial<MachineTrial> = {}): MachineTrial => ({
  k,
  allPassed: true,
  serversUp: true,
  ratio: 1.1,
  ...over,
});

describe("the machine's K", () => {
  test("is the widest of 8, 16, 24 and 32 at which every judgement passes, every server stays up and the median time is within 1.25 times solo", async () => {
    const asked: number[] = [];
    const found = await machineWidth((k) => {
      asked.push(k);
      return Promise.resolve(trial(k, k === 24 ? { ratio: MAX_RATIO + 0.01 } : {}));
    });
    expect(found.k).toBe(16);
    expect(asked).toEqual([8, 16, 24]);
  });

  test("a failed judgement or a server that went down ends it", async () => {
    expect(
      (await machineWidth((k) => Promise.resolve(trial(k, k === 16 ? { serversUp: false } : {}))))
        .k,
    ).toBe(8);
    expect((await machineWidth((k) => Promise.resolve(trial(k, { allPassed: false })))).k).toBe(0);
    expect((await machineWidth((k) => Promise.resolve(trial(k)))).k).toBe(32);
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
