/**
 * Tokens and dollars come from the request log, which holds every model call, so a probe that was
 * ended at its first write (and never reported its tokens) is in them.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spendOf } from "../../src/recall/spend.ts";
import { rescore } from "../../src/recall/results.ts";
import { SCORING, makeCase, measured, resultOf, search } from "./world.ts";

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "recall-check-spend-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const call = (model: string, input: number, write: number, read: number, output: number) => ({
  model,
  usage: { input, cache_write: write, cache_read: read, output },
});

describe("what a case cost", () => {
  test("is every model call in the request log: the four kinds of tokens, and dollars by the model's price row", async () => {
    const dir = join(root, "cost");
    makeCase(dir, {
      transcripts: { S1: search("a", { facts: [], degraded: [] }) },
      requests: [
        { model: "claude-haiku-5-5", status: 502, usage: {} }, // a call that failed has no usage
        call("claude-haiku-5-5", 10, 1000, 100000, 500),
        call("claude-sonnet-5", 1, 0, 0, 1),
      ],
    });

    const spend = await spendOf(dir);

    expect(spend.tokens).toBe(10 + 1000 + 100000 + 500 + 1 + 1);
    const haiku = (10 * 0.1 + 1000 * 0.2 + 100000 * 0.01 + 500 * 0.5) / 1e6;
    const other = (1 * 2.0 + 1 * 10.0) / 1e6;
    expect(spend.usd).toBeCloseTo(haiku + other, 9);
  });

  test("includes a session that was ended before the harness reported its tokens", async () => {
    // the transcript of the killed probe has no `result` event: only the log knows its calls
    const dir = join(root, "killed");
    makeCase(dir, {
      transcripts: { S1: search("a", { facts: [], degraded: [] }), S2: search("b", { facts: [] }) },
      requests: [
        call("claude-haiku-5-5", 5, 0, 1000, 20),
        call("claude-haiku-5-5", 5, 0, 2000, 30),
      ],
    });

    expect((await spendOf(dir)).tokens).toBe(3060);
  });

  test("is what a rescore reports, in place of what the earlier run reported", async () => {
    const folder = join(root, "old-run");
    const into = join(root, "scratch");
    mkdirSync(into);
    const name = "c-W1-treatment-0";
    makeCase(join(folder, "cases", name), {
      transcripts: { S1: search("a", { facts: [], degraded: [] }), S2: search("b", { facts: [] }) },
      requests: [call("claude-haiku-5-5", 0, 0, 1_000_000, 0)],
    });
    const old = resultOf([measured("W1", 1, 2, { tokens: 7, no_model: undefined })]);
    writeFileSync(join(folder, "result.json"), JSON.stringify(old));

    const result = await rescore(folder, SCORING, into);

    expect(result.cases[0]?.tokens).toBe(1_000_000);
    expect(result.cases[0]?.usd).toBeCloseTo(0.01, 9);
    expect(result.totals?.["p/c"]?.tokens).toBe(1_000_000);
  });
});
