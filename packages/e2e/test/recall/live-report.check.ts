/** The live report, scored from kept evidence with no session: the headline, the ladder, voids and caps. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { laterCost, render } from "../../src/live/report.ts";
import { scoreRun } from "../../src/live/score.ts";
import { SCORING, writeRun, type UnitSpec } from "./live-world.ts";

let root = "";
beforeAll(() => (root = mkdtempSync(join(tmpdir(), "recall-check-live-report-"))));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const nothing = { passed: { T4: [], T8: [] } };

/** u1: stored 4, found D1 and D2, T4 passes with D1 and D2 used. u2: a provider void on none's T4. u3: stored 3, all found, memory's T8 may be capped. */
const units = (capped: boolean): UnitSpec[] => [
  {
    memory: {
      stored: ["D1", "D2", "D3", "P1"],
      found: { T4: ["D1", "D2"] },
      passed: { T4: ["D1", "D2", "D3"], T8: [] },
      taskPasses: { T4: true },
      tokens: { T4: 1.5e6, T8: 2.5e6 },
    },
    none: { ...nothing, tokens: { T4: 2.5e6, T8: 3.5e6 } },
  },
  {
    memory: { stored: ["D1"] },
    none: { end: { T4: { kind: "void", cause: "provider", detail: "HTTP 429" } } },
  },
  {
    memory: {
      stored: ["D1", "D2", "P1"],
      found: { T4: ["D1", "D2"], T8: ["P1"] },
      passed: { T4: ["D1"], T8: ["P1"] },
      taskPasses: { T4: true },
      ...(capped ? { end: { T8: { kind: "capped" as const, seconds: 1320 } } } : {}),
      tokens: { T4: 1.5e6, T8: 2.5e6 },
    },
    none: { ...nothing, tokens: { T4: 2.5e6, T8: 3.5e6 } },
  },
];

async function reported(name: string, capped: boolean): Promise<string> {
  const folder = join(root, name);
  mkdirSync(folder);
  writeRun(folder, units(capped));
  const { meta, units: scored } = await scoreRun(folder, SCORING);
  return render(meta, scored, "Pool: none");
}

describe("the report of a kept run", () => {
  test("the headline is the first line, with the counts of the stored, found and used, and a void unit left out", async () => {
    const text = await reported("capped", true);
    const first = text.split("\n")[0] as string;
    expect(first).toContain("live-hour b1 setup haiku · 3 units, 1 void, 1 capped, 42 min");
    expect(first).toContain(
      "stored 8/15 (outright 4/6, in passing 4/6, found 0/3) [from the 3 units whose earlier session ran, 1 of them void]",
    );
    expect(first).toContain("found 5/7 · used 4/5");
    expect(first).toContain("deciding tests with memory 4/6, without 0/6");
    expect(first).toContain("tasks 2/4 vs 0/4");
  });

  test("a capped later session is scored as judged, and over 1 in 10 capped makes the cost censored", async () => {
    const text = await reported("capped-cost", true);
    expect(text.split("\n")[0]).toContain(
      "later sessions 2.0 M vs 3.0 M (censored: over 1 in 10 capped, no test)",
    );
    expect(text).toContain("u3: 1 capped");
  });

  test("with none capped the later-session cost is tested and printed with its p and its change", async () => {
    const text = await reported("whole", false);
    expect(text.split("\n")[0]).toMatch(
      /later sessions 2\.0 M vs 3\.0 M a session \(−33%, p 0\.\d\d\)/,
    );
    expect(text.split("\n")[0]).toContain("whole unit 5.0 M vs 7.0 M");
  });

  test("a pair left out for a session with no tokens is said in the printed result", async () => {
    const folder = join(root, "dropped");
    mkdirSync(folder);
    const list = units(false);
    writeRun(folder, [
      { ...list[0]!, none: { ...list[0]!.none, tokens: { T4: 0, T8: 3.5e6 } } },
      list[2]!,
    ]);
    const { meta, units: scored } = await scoreRun(folder, SCORING);
    expect(render(meta, scored, "").split("\n")[0]).toContain(
      "[1 pairs left out: a session with no tokens]",
    );
  });

  test("the claims of what E stored that matched no item are printed, so a reader sees what not stored rests on", async () => {
    const folder = join(root, "unmatched");
    mkdirSync(folder);
    writeRun(folder, [
      {
        memory: {
          stored: ["D1"],
          other: [
            "ChanServ NOTE keeps private notes on a channel",
            "An entry message of 200 CJK characters exceeds the line limit",
          ],
        },
        none: {},
      },
    ]);
    const { meta, units: scored } = await scoreRun(folder, SCORING);
    const text = render(meta, scored, "");
    expect(text).toContain("Facts the earlier session stored that matched no item");
    expect(text).toContain("u1: ChanServ NOTE keeps private notes on a channel");
    expect(text).toContain("u1: An entry message of 200 CJK characters exceeds the line limit");
    expect(text).not.toContain("u1: marker-D1");
    expect(render(meta, (await scoreRun(join(root, "whole"), SCORING)).units, "")).toContain(
      "\nnone\n",
    );
  });

  test("the ladder keeps told outright, in passing and found apart, and the void is named with its cause", async () => {
    const text = await reported("ladder", false);
    expect(text).toMatch(
      /P1 +outright, +stored 2\/3 {2}found 1\/2 \(brief 0, search 1\) {2}used 1\/1/,
    );
    expect(text).toMatch(/D1 +passing, +stored 3\/3 {2}found 2\/2/);
    expect(text).toMatch(/D8 +found, +stored 0\/3/);
    expect(text).toContain("u2 none T4: provider, HTTP 429");
    expect(text).toContain("u1 memory: suite: /api/capabilities degraded=[]");
  });

  test("the run is void when a memory server did not show its model, and when over a quarter of the units are void", async () => {
    const folder = join(root, "nomodel");
    mkdirSync(folder);
    writeRun(folder, [{ memory: { stored: ["D1"], model: false }, none: {} }]);
    const { meta, units: scored } = await scoreRun(folder, SCORING);
    expect(render(meta, scored, "").split("\n")[0]).toMatch(
      /^VOID \(a memory-arm server did not show its model loaded/,
    );
    const many = join(root, "manyvoid");
    mkdirSync(many);
    const voided: UnitSpec = {
      memory: {},
      none: { end: { E: { kind: "void", cause: "machine", detail: "x" } } },
    };
    writeRun(many, [voided, { memory: {}, none: {} }, { memory: {}, none: {} }]);
    const again = await scoreRun(many, SCORING);
    expect(render(again.meta, again.units, "").split("\n")[0]).toMatch(
      /^VOID \(1 of 3 units are void\)/,
    );
    expect(laterCost(again.units.filter((u) => !u.void)).censored).toBe(false);
  });
});
