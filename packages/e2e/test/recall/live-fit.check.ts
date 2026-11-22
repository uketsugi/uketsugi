/** The schedule worked out before a run: what fits the hour on measured times, at its edges, and the refusal that prints the arithmetic. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  CAP_E_MS,
  CAP_L_MS,
  HOUR_MS,
  fitAt,
  fitUnits,
  joined,
  measuredFrom,
  type Measured,
} from "../../src/live/fit.ts";
import { MINUTE, type ArmRecord, type UnitRecord } from "../../src/live/pair.ts";
import { liveRun } from "../../src/live/start.ts";

let root = "";
beforeAll(() => (root = mkdtempSync(join(tmpdir(), "recall-check-live-fit-"))));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const base: Measured = {
  units: 4,
  setupCachedMs: 3 * MINUTE,
  setupBuiltMs: 7 * MINUTE,
  eFinishMs: 1 * MINUTE,
  gapMs: 2 * MINUTE,
  judgeMs: 1 * MINUTE,
  lFinishMs: 1 * MINUTE,
  settleMs: 0,
  printMs: 30_000,
};

describe("the arithmetic", () => {
  test("a unit fits when a capped earlier session still leaves its later sessions their start and the hour their end, with the margin printed", () => {
    const fit = fitAt({ byUnits: [base] }, 4, true);
    // set-up 3 + cap 22 + judging 1 = 26; + finish 1 + gap 2 = later sessions start 29; tail 1 + 1 + 0.5 = 2.5; last start 55 - 18 - 2.5 = 34.5
    expect(fit.fits).toBe(true);
    expect(fit.deadlines.lastStartMs).toBe(HOUR_MS - CAP_L_MS - 2.5 * MINUTE);
    expect(fit.lines.join("\n")).toContain("later sessions start 29.0");
    // the set-up may take until the last start leaves no margin: 3 + (34.5 - 29) = 8.5
    expect(fit.setupLimitMs).toBe(8.5 * MINUTE);
    expect(fit.lines.join("\n")).toContain(
      "the set-up must be done by 8.5 (it took 3.0 when measured)",
    );
    expect(fit.lines.join("\n")).toContain(
      "last start (hour 55.0 - cap 18.0 - tail 2.5) = 34.5: margin 5.5",
    );
  });

  test("the same unit with the release built in the run uses the longer set-up", () => {
    const fit = fitAt({ byUnits: [base] }, 4, false);
    expect(fit.lines.join("\n")).toContain("later sessions start 33.0");
    expect(fit.fits).toBe(true);
  });

  test("at the edge: a start exactly on the last start fits, a millisecond after does not", () => {
    // later sessions start at set-up + 22 + 1 + 1 + 2 = set-up + 26; the last start is 34.5, so a set-up of 8.5 is exactly on it
    const on = { ...base, setupCachedMs: 8.5 * MINUTE };
    expect(fitAt({ byUnits: [on] }, 4, true).fits).toBe(true);
    expect(fitAt({ byUnits: [{ ...on, setupCachedMs: 8.5 * MINUTE + 1 }] }, 4, true).fits).toBe(
      false,
    );
  });

  test("the end is inside the hour whenever the start is by the last start: a later session to its cap ends by the printing", () => {
    const fit = fitAt({ byUnits: [base] }, 4, true);
    expect(fit.lines.join("\n")).toContain(
      "a later session to its cap ends 49.5, printed by 55.0: margin 5.5",
    );
    const on = fitAt({ byUnits: [{ ...base, setupCachedMs: 8.5 * MINUTE }] }, 4, true);
    expect(on.lines.join("\n")).toContain("ends 55.0, printed by 55.0: margin 0.0");
  });

  test("a width that was not measured does not fit, and a set-up that was not measured is named", () => {
    expect(fitAt({ byUnits: [base] }, 5, true).lines[0]).toContain(
      "not measured (measured at 4 units)",
    );
    expect(fitAt({ byUnits: [{ ...base, setupBuiltMs: null }] }, 4, false).lines[0]).toContain(
      "freshly built release was not measured",
    );
  });
});

describe("lowering N", () => {
  const wide: Measured = { ...base, units: 4, gapMs: 9 * MINUTE, setupCachedMs: 12 * MINUTE };
  const narrow: Measured = { ...base, units: 2 };

  test("takes the largest N that fits, using the narrowest measure that covers it", () => {
    const fit = fitUnits({ byUnits: [narrow, wide] }, 4, true);
    expect(fit.units).toBe(2);
    expect(fit.fits).toBe(true);
    expect(fit.tried.map((f) => f.units)).toEqual([4, 3, 2]);
  });

  test("refuses when nothing fits, and keeps the arithmetic of every N it tried", () => {
    const fit = fitUnits({ byUnits: [{ ...base, units: 4, setupCachedMs: 20 * MINUTE }] }, 4, true);
    expect(fit.fits).toBe(false);
    expect(fit.units).toBe(0);
    expect(fit.tried).toHaveLength(4);
  });
});

describe("reading the times a run shows", () => {
  const arm = (
    end: number,
    ready: number,
    later: number,
    extra: ArmRecord["phases"] = [],
  ): ArmRecord => ({
    phases: [
      { name: "E: judge T2 #0", startMs: 0, endMs: 0.75 * MINUTE },
      { name: "T4: copy evidence", startMs: 0, endMs: 0.4 * MINUTE },
      ...extra,
    ],
    earlier: { startedMs: 7 * MINUTE, endedMs: end, readyMs: ready, end: { kind: "done" } },
    later: {
      T4: {
        startedMs: later,
        endedMs: later + 8 * MINUTE,
        readyMs: later + 8.5 * MINUTE,
        end: { kind: "done" },
      },
      T8: {
        startedMs: later,
        endedMs: later + 5 * MINUTE,
        readyMs: later + 5.25 * MINUTE,
        end: { kind: "done" },
      },
    },
    carried: { memory: [], instructions: [] },
  });

  test("the slowest of each phase over the arms, and the set-up from the first earlier session's start", () => {
    const units: UnitRecord[] = [
      {
        unit: 1,
        void: false,
        arms: {
          memory: arm(20 * MINUTE, 20.5 * MINUTE, 22 * MINUTE),
          none: arm(18 * MINUTE, 19.25 * MINUTE, 21.5 * MINUTE),
        },
      },
    ];
    const m = measuredFrom({ units, releaseCached: true, printMs: 20_000 });
    expect(m.units).toBe(1);
    expect(m.setupCachedMs).toBe(7 * MINUTE);
    expect(m.setupBuiltMs).toBeNull();
    expect(m.eFinishMs).toBe(1.25 * MINUTE);
    expect(m.gapMs).toBe(2.25 * MINUTE);
    expect(m.judgeMs).toBe(0.75 * MINUTE);
    expect(m.lFinishMs).toBe(0.5 * MINUTE);
    expect(m.settleMs).toBe(0.4 * MINUTE);
    expect(m.printMs).toBe(20_000);
  });

  test("two set-ups of one kind keep the slower", () => {
    const a = { ...base, setupBuiltMs: 3 * MINUTE };
    const b = { ...base, setupBuiltMs: 5 * MINUTE };
    expect(joined([a, b]).byUnits[0]?.setupBuiltMs).toBe(5 * MINUTE);
    expect(joined([b, a]).byUnits[0]?.setupBuiltMs).toBe(5 * MINUTE);
  });

  test("two runs of one width keep the slower, and each set-up seen", () => {
    const a = { ...base, setupCachedMs: 3 * MINUTE, setupBuiltMs: null, gapMs: 1 * MINUTE };
    const b = { ...base, setupCachedMs: null, setupBuiltMs: 7 * MINUTE, gapMs: 2 * MINUTE };
    const set = joined([a, b]);
    expect(set.byUnits).toHaveLength(1);
    expect(set.byUnits[0]).toMatchObject({
      setupCachedMs: 3 * MINUTE,
      setupBuiltMs: 7 * MINUTE,
      gapMs: 2 * MINUTE,
    });
  });
});

describe("the run command", () => {
  function model(): string {
    const folder = join(root, "model");
    mkdirSync(join(folder, "node_modules"), { recursive: true });
    mkdirSync(join(folder, "models"), { recursive: true });
    return folder;
  }
  function reading(): string {
    const folder = join(root, "reading");
    mkdirSync(join(folder, "cases", "u1-memory-E", "transcripts"), { recursive: true });
    writeFileSync(
      join(folder, "cases", "u1-memory-E", "transcripts", "E.0.jsonl"),
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
    return folder;
  }

  test("does not start without the measured times", async () => {
    await expect(
      liveRun({
        units: "4",
        "model-dir": model(),
        "reading-from": reading(),
        out: join(root, "o1"),
      }),
    ).rejects.toThrow(/pass --measured/);
  });

  test("does not start what cannot finish: it refuses, prints the arithmetic, and creates nothing", async () => {
    const slow = join(root, "slow.json");
    writeFileSync(
      slow,
      JSON.stringify({
        byUnits: [{ ...base, setupCachedMs: 25 * MINUTE, setupBuiltMs: 25 * MINUTE }],
      }),
    );
    const out = join(root, "o2");
    const error = await liveRun({
      units: "4",
      "model-dir": model(),
      "reading-from": reading(),
      measured: slow,
      out,
    }).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(error).toContain("4 units do not fit the hour on this machine");
    expect(error).toContain("nothing was started");
    expect(error).toContain("OVER by");
    expect(error).toContain("1 units, measured at 4 units at once");
    expect(CAP_E_MS).toBe(22 * MINUTE);
  });
});
