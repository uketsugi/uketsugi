/**
 * Hand labels decide what a stored fact states, where a run has them: a fact labelled as an item
 * counts as stored for it (and found and used follow), a fact labelled as no item does not count
 * even where a pattern matches, a labels file that does not fit the run's stores is refused, and the
 * printed result says what it rests on.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { render } from "../../src/live/report.ts";
import { scoreRun } from "../../src/live/score.ts";
import { SCORING, writeRun, type UnitSpec } from "./live-world.ts";

let root = "";
beforeAll(() => (root = mkdtempSync(join(tmpdir(), "recall-check-live-labels-"))));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** E stored markers for D1 and D2 (the patterns match them) and a paraphrase of P1 no pattern matches, which L was handed and used. */
const spec: UnitSpec = {
  memory: {
    stored: ["D1", "D2"],
    other: ["Standing rule: whatever ChanServ volunteers goes out as a bracketed NOTICE"],
    foundOther: { T8: [0] },
    passed: { T8: ["P1"] },
    taskPasses: { T8: true },
  },
  none: {},
};

const record = (fact: string, states: string[], why = "read it") => ({
  unit: 1,
  fact,
  states,
  why,
});
const LABELS = {
  items: ["P1", "D2", "D1", "D3", "D8"],
  records: [record("f-D1", []), record("f-D2", ["D2"]), record("o-0", ["P1"])],
};

async function run(name: string, labels?: unknown, units: UnitSpec[] = [spec]) {
  const folder = join(root, name);
  mkdirSync(folder);
  writeRun(folder, units);
  if (labels !== undefined) writeFileSync(join(folder, "labels.json"), JSON.stringify(labels));
  return folder;
}

describe("a run with no labels", () => {
  test("is scored by the patterns and says it is a floor", async () => {
    const { meta, units } = await scoreRun(await run("none"), SCORING);
    const text = render(meta, units, "");
    expect(text).toContain("Stored rests on: patterns alone, a floor");
    expect(text.split("\n")[0]).toContain("stored 2/5 (outright");
    expect(text.split("\n")[0]).not.toContain("by labels");
  });
});

describe("a run with labels", () => {
  test("the labels decide: a paraphrase labelled P1 is stored, found and used; a fact labelled as no item does not count where a pattern matches", async () => {
    const { meta, units } = await scoreRun(await run("labelled", LABELS), SCORING);
    const text = render(meta, units, "");
    expect(text.split("\n")[0]).toContain("stored 2/5 by labels");
    expect(text).toMatch(
      /P1 +outright, +stored 1\/1 {2}found 1\/1 \(brief 0, search 1\) {2}used 1\/1/,
    );
    expect(text).toMatch(/D1 +passing, +stored 0\/1/);
    expect(text).toMatch(/D2 +outright, +stored 1\/1/);
  });

  test("says how many facts were labelled, how many cells differ from the patterns, and both stored figures when they differ", async () => {
    const labels = {
      ...LABELS,
      records: [record("f-D1", []), record("f-D2", []), record("o-0", ["P1"])],
    };
    const { meta, units } = await scoreRun(await run("differ", labels), SCORING);
    const text = render(meta, units, "");
    expect(text).toContain(
      "Stored rests on: hand labels of 3 stored facts (labels.json beside the run); 3 cells differ from what the patterns alone give.",
    );
    expect(text.split("\n")[0]).toContain("stored 1/5 by labels (by patterns alone 2/5)");
  });

  test("the facts labelled as no item are the ones printed as matching no item", async () => {
    const { meta, units } = await scoreRun(await run("nomatch", LABELS), SCORING);
    const text = render(meta, units, "");
    expect(text).toContain("u1: marker-D1 is what the person told us");
    expect(text).not.toContain("u1: Standing rule");
  });

  test("agrees with the patterns when the labels say what they say", async () => {
    const same = {
      ...LABELS,
      records: [record("f-D1", ["D1"]), record("f-D2", ["D2"]), record("o-0", [])],
    };
    const { meta, units } = await scoreRun(await run("agree", same), SCORING);
    const text = render(meta, units, "");
    expect(text.split("\n")[0]).toContain("stored 2/5 by labels ");
    expect(text).toContain("0 cells differ from what the patterns alone give");
  });
});

describe("labels that do not fit the run are refused", () => {
  test("a fact the run did not store", async () => {
    const labels = { ...LABELS, records: [...LABELS.records, record("f-D9", ["D1"])] };
    await expect(scoreRun(await run("ghost", labels), SCORING)).rejects.toThrow(
      /refused[\s\S]*1\/f-D9: the run's store of unit 1 holds no such fact/,
    );
  });

  test("a stored fact left out", async () => {
    const labels = { ...LABELS, records: LABELS.records.slice(0, 2) };
    await expect(scoreRun(await run("left-out", labels), SCORING)).rejects.toThrow(
      /1\/o-0: a stored fact with no label/,
    );
  });

  test("a unit, an item or a reason that is not in order, and a fact labelled twice", async () => {
    const bad = {
      items: LABELS.items,
      records: [
        ...LABELS.records,
        record("o-0", ["P1"]),
        { unit: 7, fact: "f-D1", states: ["D1"], why: "x" },
        record("f-D1", ["D77"], " "),
      ],
    };
    const message = await scoreRun(await run("bad", bad), SCORING).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(message).toContain("unit 7 is not in the run");
    expect(message).toContain("1/o-0: labelled twice");
    expect(message).toContain("D77 is not an item");
    expect(message).toContain("no reason given");
  });

  test("a labels file that does not name the five items", async () => {
    await expect(
      scoreRun(await run("items", { ...LABELS, items: ["P1"] }), SCORING),
    ).rejects.toThrow(/items must be exactly/);
  });
});

describe("a void run still says what its earlier sessions stored", () => {
  const voided: UnitSpec = {
    memory: {
      stored: ["D1", "D2"],
      end: { T4: { kind: "void", cause: "clock", detail: "past minute 30" } },
    },
    none: {},
  };

  test("the stored figure counts every unit whose earlier session ran, marked as such, and a void run's headline does not read 0/0", async () => {
    const { meta, units } = await scoreRun(
      await run("void-stored", undefined, [voided, voided]),
      SCORING,
    );
    const first = render(meta, units, "").split("\n")[0] as string;
    expect(first).toContain("2 units, 2 void");
    expect(first).toContain("stored 4/10");
    expect(first).toContain("[from the 2 units whose earlier session ran, 2 of them void]");
    expect(first).not.toContain("stored 0/0");
  });

  test("the ladder's stored rung counts them and says so", async () => {
    const { meta, units } = await scoreRun(await run("void-ladder", undefined, [voided]), SCORING);
    const text = render(meta, units, "");
    expect(text).toContain("stored counts every unit whose earlier session ran, void or not");
    expect(text).toMatch(/D1 +passing, +stored 1\/1 {2}found 0\/0/);
  });

  test("a unit whose earlier session did not start counts for nothing", async () => {
    const never: UnitSpec = {
      memory: { end: { E: { kind: "void", cause: "clock", detail: "x" } } },
      none: {},
    };
    const { meta, units } = await scoreRun(await run("void-never", undefined, [never]), SCORING);
    expect(render(meta, units, "").split("\n")[0]).toContain("stored 0/0");
  });
});
