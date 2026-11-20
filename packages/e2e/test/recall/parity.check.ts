/**
 * Parity with the Python suite: its reviewed runs, kept with their evidence, scored again here with
 * this suite's measure and merged as it merged them, give the same recall, cell for cell. The runs are
 * not part of the repository: UKT_RECALL_PARITY names a folder holding the run folders it merged
 * (in order, named in the reference's `merged_from`), and UKT_RECALL_PARITY_REFERENCE the reference's
 * `result.merged.json`. The folders are copied first: scoring writes beside the evidence.
 *
 * One field is not compared: `unneeded_records` of a few cells, which the reference computed with
 * item patterns as they were before the suite's last tightening; the Python suite's own rescore of the
 * same folders today agrees with this suite on every field.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { adapterFor } from "../../src/recall/adapters.ts";
import { seedOf } from "../../src/recall/case.ts";
import type { Scoring } from "../../src/recall/evidence.ts";
import { loadItems } from "../../src/recall/items.ts";
import type { Cell, Result } from "../../src/recall/report.ts";
import { merge, rescore } from "../../src/recall/results.ts";

let root = "";
let reference: Result & { merged_from: string[] };
let merged: Result;

const withoutUnneeded = (r: object): object =>
  Object.fromEntries(Object.entries(r).filter(([k]) => k !== "unneeded_records"));

const cellKey = (c: Cell): string =>
  [c.config, c.item, c.kind, c.repeat, c.task, c.session].join("|");

beforeAll(async () => {
  const folder = process.env["UKT_RECALL_PARITY"];
  const file = process.env["UKT_RECALL_PARITY_REFERENCE"];
  if (folder === undefined || file === undefined) {
    throw new Error(
      "set UKT_RECALL_PARITY (the folder of the Python suite's kept runs) and UKT_RECALL_PARITY_REFERENCE (its result.merged.json)",
    );
  }
  reference = JSON.parse(readFileSync(file, "utf8")) as typeof reference;
  root = mkdtempSync(join(tmpdir(), "recall-check-parity-"));
  const scoring: Scoring = {
    items: await loadItems(),
    seedClaims: new Set((await seedOf()).map((s) => String(s["claim"]))),
    boilerplate: adapterFor("uketsugi").boilerplate,
    mode: "quick",
  };
  const copies = reference.merged_from.map((f) => {
    const copy = join(root, basename(f));
    execFileSync("cp", ["-a", join(folder, basename(f)), copy]);
    return copy;
  });
  for (const copy of copies) await rescore(copy, scoring);
  merged = await merge(copies);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the reviewed runs of the Python suite, scored here", () => {
  test("every cell is the same: recalled, how and from where, late, the old value, characters, records, wrote", () => {
    const ours = new Map(merged.cells.map((c) => [cellKey(c), c]));

    expect(ours.size).toBe(reference.cells.length);
    for (const c of reference.cells) {
      const mine = ours.get(cellKey(c));
      expect(mine, cellKey(c)).toBeDefined();
      expect(withoutUnneeded((mine as Cell).recalled), cellKey(c)).toEqual(
        withoutUnneeded(c.recalled),
      );
      expect((mine as Cell).used, cellKey(c)).toEqual(c.used);
    }
  });

  test("what was stored, and by whom, is the same for every case", () => {
    const stored = (r: Result) =>
      Object.fromEntries(r.cases.map((c) => [`${c.item}|${c.kind}|${c.repeat}`, c.stored ?? null]));

    expect(stored(merged)).toEqual(stored(reference));
  });

  test("the headline is the same: recall, per item, the controls, and the items left out", () => {
    const [k] = Object.keys(reference.recall) as [string];
    const [mine, theirs] = [merged.recall[k], reference.recall[k]];

    expect(mine?.hits).toBe(theirs?.hits);
    expect(mine?.cells).toBe(theirs?.cells);
    expect(mine?.per_item).toEqual(theirs?.per_item);
    expect(mine?.control).toEqual(theirs?.control);
    expect(mine?.left_out).toEqual(theirs?.left_out);
    expect([mine?.low, mine?.high]).toEqual([theirs?.low, theirs?.high]);
  });
});
