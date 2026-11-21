/**
 * A run is void when any search result of it is marked `no_model` (the server matched words only): the
 * case's scoring counts them in every session, and the headline of a run that has any says it is void
 * and `--compare` refuses it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { scoreCase } from "../../src/recall/evidence.ts";
import { compare, failed, headline } from "../../src/recall/report.ts";
import { SCORING, errored, key, makeCase, measured, resultOf, search } from "./world.ts";

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "recall-check-void-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const MARKED = { facts: [], degraded: ["no_model"] };
const CLEAN = { facts: [], degraded: [] };

describe("a search result marked no_model", () => {
  test("is counted in every session of the case, the plant's too, and not a result of something else", async () => {
    const dir = join(root, "marked");
    makeCase(dir, {
      transcripts: {
        S1: search("a", MARKED),
        S2: search("b", CLEAN) + search("c", MARKED) + search("d", MARKED, "Bash"),
      },
    });

    const scored = await scoreCase(dir, key("W1"), SCORING);

    expect(scored.no_model).toBe(2);
  });

  test("is not found in a run whose results all say the model matched", async () => {
    const dir = join(root, "clean");
    makeCase(dir, { transcripts: { S1: search("a", CLEAN), S2: search("b", CLEAN) } });

    expect((await scoreCase(dir, key("W1"), SCORING)).no_model).toBe(0);
  });
});

describe("a run with such results", () => {
  const voided = resultOf([measured("W1", 1, 2, { no_model: 3 }), measured("W2", 1)]);
  const sound = resultOf([measured("W1", 1), measured("W2", 1)]);

  test("says in its headline that it is void and why", () => {
    expect(headline(voided).split("\n")[0]).toMatch(/VOID.*3 search results.*no_model/);
    expect(headline(sound)).not.toMatch(/VOID/);
  });

  test("is refused by the comparison, from either side", () => {
    expect(compare(voided, sound)).toMatch(/refused.*void/);
    expect(compare(sound, voided)).toMatch(/refused.*void/);
  });

  test("is not set beside a run that never recorded whether its results were marked", () => {
    const legacy = resultOf([measured("W1", 1, 2, { no_model: undefined }), measured("W2", 1)]);

    expect(compare(sound, legacy)).toMatch(/refused.*never recorded/);
  });

  test("makes the run end with a failing exit, as an errored case does and a sound run does not", () => {
    expect(failed(voided)).toBe(true);
    expect(failed(resultOf([measured("W1", 1), errored("W2")]))).toBe(true);
    expect(failed(sound)).toBe(false);
  });
});

describe("a run whose server was cut off between sessions", () => {
  test("says in its headline how many stops killed it and how many starts recovered a store, and says nothing of a clean run", () => {
    const cut = resultOf([
      measured("W1", 1, 2, { killed_stops: 2, recovered_starts: 1 }),
      measured("W2", 1, 2, { killed_stops: 1, recovered_starts: 0 }),
    ]);
    const clean = resultOf([measured("W1", 1), measured("W2", 1)]);

    expect(headline(cut)).toMatch(/3 stops killed the server and 1 starts recovered a store/);
    expect(headline(clean)).not.toMatch(/killed the server/);
  });
});
