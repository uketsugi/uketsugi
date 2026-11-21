/** What a run proves of itself: the no-memory arm had no server, and the memory arm's later servers served E's store. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { proofsOf } from "../../src/live/proofs.ts";
import type { RunFile } from "../../src/live/score.ts";

let root = "";
beforeAll(() => (root = mkdtempSync(join(tmpdir(), "recall-check-proofs-"))));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ran = { startedMs: 0, endedMs: 1, end: { kind: "done" as const } };
const carried = { memory: [], instructions: [] };
const run: RunFile = {
  build: "b",
  config: "setup",
  model: "haiku",
  harness: "2",
  hash: "h",
  minutes: 1,
  units: [
    {
      unit: 1,
      void: false,
      arms: {
        memory: { earlier: ran, later: { T4: ran, T8: ran }, carried },
        none: { earlier: ran, later: { T4: ran, T8: ran }, carried },
      },
    },
  ],
};

function folder(name: string, files: Record<string, string>): string {
  const out = join(root, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(out, "cases", path.split("/")[0] as string), { recursive: true });
    writeFileSync(join(out, "cases", path), text);
  }
  return out;
}

const facts = (...ids: string[]): string => JSON.stringify(ids.map((id) => ({ id, claim: "c" })));

test("holds when the no-memory arm has no server and the later servers served what E left", async () => {
  const out = folder("good", {
    "u1-memory-E/facts.json": facts("a", "b"),
    "u1-memory-T4/facts.json": facts("a", "b", "c"),
    "u1-memory-T8/facts.json": facts("a", "b"),
    "u1-none-E/steps.jsonl": "",
  });
  expect(await proofsOf(out, run)).toEqual([]);
});

test("fails when a no-memory case has a server log, or a later server lacks what E left", async () => {
  const out = folder("bad", {
    "u1-memory-E/facts.json": facts("a", "b"),
    "u1-memory-T4/facts.json": facts("a"),
    "u1-memory-T8/facts.json": facts("a", "b"),
    "u1-none-T8/server.log": "x",
  });
  const failed = await proofsOf(out, run);
  expect(failed).toHaveLength(2);
  expect(failed.join("\n")).toContain("u1 none T8: the no-memory arm had a server");
  expect(failed.join("\n")).toContain(
    "u1 memory T4: the server on the carried store did not serve what E left (b)",
  );
});
