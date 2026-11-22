/** The cap rule at its boundary, and what the later-session cost says it left out. */
import { describe, expect, test } from "vitest";
import { laterCost } from "../../src/live/report.ts";
import type { ArmScore, LaterScore, UnitScore } from "../../src/live/score.ts";

const later = (tokens: number, capped = false): LaterScore => ({
  tokens,
  usd: 0,
  capped,
  passed: false,
  tests: {},
  found: {},
});
const arm = (t4: LaterScore, t8: LaterScore): ArmScore => ({
  earlier: { tokens: 1, usd: 0, capped: false },
  later: { T4: t4, T8: t8 },
  stored: {},
  modelLine: null,
  unmatched: [],
  storedByPatterns: {},
  labelled: null,
  timing: {
    phases: [],
    earlierStartMs: null,
    earlierEndMs: null,
    earlierReadyMs: null,
    laterStartMs: { T4: null, T8: null },
  },
  minutes: 1,
});

/** Five units: ten later sessions in each arm, of which the first `capped` of the memory arm are capped. */
function units(capped: number, tokens = 1e6): UnitScore[] {
  return Array.from({ length: 5 }, (_, i) => ({
    unit: i + 1,
    void: false,
    voids: [],
    leaked: false,
    cappedSessions: 0,
    sessions: 6,
    arms: {
      memory: arm(later(tokens, i * 2 < capped), later(tokens, i * 2 + 1 < capped)),
      none: arm(later(2e6), later(2e6)),
    },
  }));
}

describe("the cap rule", () => {
  test("exactly 1 later session in 10 capped is not censored; more than that is", () => {
    expect(laterCost(units(1)).censored).toBe(false);
    expect(laterCost(units(1)).p).not.toBeNull();
    expect(laterCost(units(2)).censored).toBe(true);
    expect(laterCost(units(2)).p).toBeNull();
    expect(laterCost(units(0)).censored).toBe(false);
  });
});

describe("pairs left out", () => {
  test("a pair with a session that has no tokens is counted as left out", () => {
    const all = units(0);
    const broken: UnitScore = {
      ...all[0]!,
      arms: { ...all[0]!.arms, memory: arm(later(0), later(1e6)) },
    };
    expect(laterCost([broken, ...all.slice(1)]).dropped).toBe(1);
    expect(laterCost(all).dropped).toBe(0);
  });
});
