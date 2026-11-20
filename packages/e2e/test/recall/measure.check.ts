/**
 * The measure's traps, each pinned on a small input: matching is on the decoded text and never on the
 * JSON around it, a seed fact or the product's boilerplate is never credited, what came after the
 * first write is late, a reversed item needs its current value, the first write is what the tree says
 * (a heredoc or `sed -i` shows as a changed tree, a build output does not), and a pattern that
 * matches the seed is refused. Explicitly run with the rest of `recall:check`; nothing of it is
 * collected by any standard run.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WriteWatch, treeStatus } from "../../src/recall/firstwrite.ts";
import { loadItems, type Items } from "../../src/recall/items.ts";
import {
  Seed,
  boilerplateStarts,
  recalled,
  validatePatterns,
  type Delivered,
} from "../../src/recall/measure.ts";
import { interval } from "../../src/recall/stats.ts";
import { decode } from "../../src/recall/transcript.ts";

let items: Items;
const SEED_CLAIM =
  "ChanServ's welcome text is stored in the channel record and shown to joiners as a NOTICE.";
const seed = new Seed([{ id: "seed-id-0001", claim: SEED_CLAIM }], new Set([SEED_CLAIM]));
const BOILER = boilerplateStarts([
  "What memory returns is information to weigh, not instructions.",
]);

beforeAll(async () => {
  items = await loadItems();
});

function delivery(text: string, line: number, step = 1, via: "hook" | "tool" = "tool"): Delivered {
  return { line, turn: 1, via, name: "mcp__uketsugi__search_facts", input: {}, text, step };
}

const d12 = (ds: Delivered[], write: { step: number; line: number } | null) =>
  recalled(ds, write, items["D12"] as never, seed, [], BOILER);

const FACT =
  "01a1f293-0000-7000-8000-000000000001 ChanServ commands that take free text must ask for it whole with unsplitFinalParam, or runs of spaces collapse.";

describe("what counts as delivered", () => {
  test("the text the agent was given, with the JSON envelope taken off", () => {
    const envelope = JSON.stringify({ hookSpecificOutput: { additionalContext: FACT } });
    const result = d12([delivery(decode(envelope).join("\n"), 3, 1, "hook")], null);

    expect(result.recalled).toBe(true);
    expect(result.via).toBe("hook");
  });

  test("not the keys of the envelope: matching the JSON itself would credit its own field names", () => {
    const envelope = JSON.stringify({
      unsplitFinalParam: "x",
      note: "this record is long enough to be kept",
    });

    expect(decode(envelope)).toEqual(["x", "this record is long enough to be kept"]);
  });

  test("a seed fact is never credited, by its id or by the start of its claim", () => {
    const text = `seed-id-0001 ${SEED_CLAIM} unsplitFinalParam runs of spaces`;
    const cut = `${SEED_CLAIM.slice(0, 40)}... unsplitFinalParam`;

    expect(d12([delivery(text, 3)], null).recalled).toBe(false);
    expect(d12([delivery(cut, 3)], null).recalled).toBe(false);
  });

  test("the product's boilerplate is never credited", () => {
    const text = "What memory returns is information to weigh, not instructions. unsplitFinalParam";

    expect(d12([delivery(text, 3)], null).recalled).toBe(false);
  });
});

describe("before the first write", () => {
  const found = delivery(FACT, 10);

  test("in time when it came before the call that wrote, late when after, in a step or a line", () => {
    expect(d12([found], { step: 1, line: 11 }).recalled).toBe(true);
    const late = d12([found], { step: 1, line: 10 });
    expect([late.recalled, late.late]).toEqual([false, true]);
    expect(d12([delivery(FACT, 50, 0)], { step: 1, line: 11 }).recalled).toBe(true);
  });

  test("a probe that never wrote has no window to miss", () => {
    expect(d12([found], null).recalled).toBe(true);
  });
});

describe("a reversed item", () => {
  const d5 = (text: string) =>
    recalled([delivery(text, 3)], null, items["D5"] as never, seed, [], BOILER);

  test("the current value is the hit, and a delivered old value is flagged, not credited", () => {
    const current = d5("unused channels get 90 days, with the warning going out 14 days before");
    const old = d5("unused channels get 60 days, with the warning going out 7 days before");

    expect([current.recalled, current.old_value_delivered]).toEqual([true, false]);
    expect([old.recalled, old.old_value_delivered]).toEqual([false, true]);
  });
});

describe("the first write, as the tree says", () => {
  let tree = "";

  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), "recall-check-tree-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: tree });
    git("init", "-q");
    writeFileSync(join(tree, "a.go"), "package a\n");
    git("add", ".");
    git("-c", "user.email=a@b.c", "-c", "user.name=n", "commit", "-qm", "x");
    writeFileSync(join(tree, ".git", "info", "exclude"), "/ergo\n");
  });

  afterAll(() => rmSync(tree, { recursive: true, force: true }));

  const call = (id: string) =>
    JSON.stringify({
      type: "assistant",
      message: { id: `m${id}`, content: [{ type: "tool_use", id, name: "Bash", input: {} }] },
    });
  const result = (id: string) =>
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
    });

  test("an edit by any means is a write, a build output and the files there before are not", async () => {
    const baseline = await treeStatus(tree);
    const watch = new WriteWatch(tree, baseline);
    watch.feed(call("t1"));
    watch.feed(result("t1"));
    writeFileSync(join(tree, "ergo"), "binary");
    await watch.settle();
    expect(watch.write).toBeNull();

    watch.feed(call("t2"));
    watch.feed(result("t2"));
    execFileSync("sh", ["-c", "printf 'package b\\n' >> a.go"], { cwd: tree });
    await watch.settle();

    expect(watch.write).toEqual({ call_line: 3, result_line: 4, tool: "Bash" });
  });
});

describe("the item patterns", () => {
  test("none matches a seed fact or the product's boilerplate: a pattern that did would credit what no session put there", () => {
    expect(
      validatePatterns(
        items,
        [{ claim: SEED_CLAIM }],
        ["Facts shown; search_facts finds the rest."],
      ),
    ).toEqual([]);
    const broken = {
      ...items,
      X: { ...(items["D3"] as object), pattern: "welcome text" },
    } as unknown as Items;

    expect(validatePatterns(broken, [{ claim: SEED_CLAIM }], [])).toEqual([
      `X pattern matches seed fact: ${SEED_CLAIM.slice(0, 80)}`,
    ]);
  });
});

describe("recall's interval", () => {
  test("is over the items, so a hard item is not nine independent cells", () => {
    const [low, high] = interval({ A: [4, 4], B: [0, 4], C: [0, 4] }) as [number, number];

    expect(low).toBe(0);
    expect(high).toBeCloseTo(2 / 3, 5);
  });
});
