import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEmbedder } from "@uketsugi/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { citationOf } from "../src/benchmark/replay/data.ts";
import { briefHolds, saysWithin } from "../src/benchmark/replay/brief.ts";
import { floorFails } from "../src/benchmark/replay/causes.ts";
import { loadReplayData, missingFiles } from "../src/benchmark/replay/data.ts";
import { namingOf } from "../src/benchmark/replay/naming.ts";
import { VARIANTS, withRelaxed } from "../src/benchmark/replay/profile.ts";
import { loadModel, openEnv } from "../src/benchmark/replay/env.ts";
import { replayShape } from "../src/benchmark/replay/replay.ts";
import { sectionOf } from "../src/benchmark/replay/report.ts";

/** A synthetic project: a fact that states the item, filler, and three probe cells. */
const TARGET = "deploys to staging run from the release branch, never from main";
const fact = (id: string, claim: string, seed = false) => ({
  id,
  claim,
  detail: null,
  question: null,
  citations: ["src/deploy.ts"],
  seed,
});
const filler = Array.from({ length: 12 }, (_, i) =>
  fact(
    `f000000000000-${i}`,
    `staging deploy checklist step ${i}: wait for the pipeline to finish`,
    true,
  ),
);
const cell = (query: string) => ({
  task: "T1",
  session: "S1",
  queries: [{ query, confidence: "strong" }],
});
const entry = {
  case: "X-0",
  item: "X",
  repeat: 0,
  facts: [...filler, fact("aaaaaaaaaaaaa-target", TARGET)],
  cells: [
    cell("which branch do staging deploys run from"),
    cell("how do I rotate the signing certificate"),
    cell("staging deploy checklist step wait pipeline"),
  ],
};
const labels = { aaaaaaaaaaaaa: { item: "X", stretch: "release branch" } };

let dir = "";
function write(files: Record<string, unknown>): string {
  dir = mkdtempSync(join(tmpdir(), "replay-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(content));
  }
  return dir;
}
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const synthetic = () =>
  write({
    "labels.json": labels,
    "own.json": { cases: [entry] },
    "project.json": { cases: [entry] },
  });

describe("the replay's data", () => {
  test("absent data is named, file by file, and a loader refuses it", () => {
    const empty = write({ "labels.json": labels });
    expect(missingFiles(empty)).toEqual(["own.json", "project.json"]);
    expect(() => loadReplayData(empty)).toThrow(/missing own.json, project.json/);
  });

  test("a fact is a target when a person labelled it for the case's item and it was written in the case", () => {
    const data = loadReplayData(synthetic());
    expect([...(data.shapes.own[0]?.targets ?? [])]).toEqual(["aaaaaaaaaaaaa-target"]);
  });
});

describe("a replay through the product's search", () => {
  test("words only: the needed fact is found by its words, missed by others, and every miss has a cause", async () => {
    const data = loadReplayData(synthetic());
    const env = await openEnv(null);
    try {
      const rows = await replayShape(env, "own", data.shapes.own, data.labels);
      expect(rows.map((row) => row.place)).toEqual([1, null, expect.any(Number)]);
      expect(rows[1]?.miss?.cause).toBe("query");
      expect(rows[1]?.miss?.control).toBe(1);
      expect(rows[2]?.miss?.cause).toBe("outranked");
      expect(sectionOf("own", "words", rows).join("\n")).toContain(
        "needed fact in the top 10: 1 of 3",
      );
    } finally {
      await env.close();
    }
  });

  test("the same data twice gives the same rows", async () => {
    const data = loadReplayData(synthetic());
    const run = async () => {
      const env = await openEnv(null);
      try {
        return await replayShape(env, "own", data.shapes.own, data.labels);
      } finally {
        await env.close();
      }
    };
    expect(await run()).toEqual(await run());
  });

  test("with an embedder every search is made with it; a search that was not is void", async () => {
    const data = loadReplayData(synthetic());
    const env = await openEnv(new FakeEmbedder());
    try {
      const rows = await replayShape(env, "own", data.shapes.own, data.labels);
      expect(rows.every((row) => row.arm === "model")).toBe(true);
    } finally {
      await env.close();
    }
    const word = await openEnv(null);
    const modelled = await openEnv(new FakeEmbedder());
    try {
      // An arm that says it ran with the model but whose store has no vectors is void.
      const claimsModel = { ...word, model: true };
      await expect(replayShape(claimsModel, "own", data.shapes.own, data.labels)).rejects.toThrow(
        /without a vector.*void/,
      );
      // An arm that says it ran words only but whose search used a model is void too.
      const claimsWords = { ...modelled, model: false };
      await expect(replayShape(claimsWords, "own", data.shapes.own, data.labels)).rejects.toThrow(
        /degraded.*expects \[no_model\]/,
      );
    } finally {
      await word.close();
      await modelled.close();
    }
  });

  test("a model folder that holds no model is refused, not run word-only", async () => {
    await expect(loadModel(tmpdir())).rejects.toThrow(/model is not usable/);
  });
});

describe("the brief and the floor", () => {
  const target = fact("t", `${"x".repeat(200)} the release branch rule`);
  const label = { item: "X", stretch: "release branch" };
  test("a stretch past the cut is lost at 170 and kept at 300", () => {
    expect(saysWithin(target, label, 170)).toBe(false);
    expect(saysWithin(target, label, 300)).toBe(true);
    expect(saysWithin(target, { item: "X", stretch: null }, 170)).toBe(true);
  });

  test("a fact the brief does not list is not held", () => {
    const hold = briefHolds({ text: "a result" }, new Map([["t", target]]), new Map());
    expect(hold.listed).toBe(false);
    expect(hold.chars).toBe(0);
  });

  test("a brief's length is that of its text, which ends the result's", () => {
    const hold = briefHolds({ text: "found\n\nSession brief for x.\nmore" }, new Map(), new Map());
    expect(hold.chars).toBe("Session brief for x.\nmore".length);
  });

  test("a short text naming the person is published as a person's word, a file or a sentence is not", () => {
    expect(citationOf("project maintainer (session user)")).toEqual({
      kind: "person",
      who: "project maintainer (session user)",
    });
    expect(citationOf("irc/user.go:12-20@47b63c9b")).toBe("irc/user.go:12-20@47b63c9b");
    expect(citationOf('{"kind":"observation","who":"the person requesting"}')).toMatch(/^\{/);
    expect(citationOf(`Rule from the maintainer: ${"x".repeat(80)}`)).toMatch(/^Rule/);
  });

  test("the keyword floor drops only a thin, far fact that wording alone found", () => {
    const profile = { vectorCutoff: 0.78, keywordFloor: 0.25 };
    expect(floorFails({ keyword: 3 }, 0.5, 0.1, profile)).toBe(true);
    expect(floorFails({ keyword: 3 }, 0.5, 0.3, profile)).toBe(false);
    expect(floorFails({ keyword: 3, vector: 9 }, 0.5, 0.1, profile)).toBe(false);
    expect(floorFails({ keyword: 3 }, null, 0.1, profile)).toBe(false);
  });
});

describe("naming and relaxing", () => {
  const store = [
    ...Array.from({ length: 30 }, (_, i) =>
      fact(`g${i}`, `the channel setting number${i} is stored`),
    ),
    fact("t", "unsplitFinalParam keeps spacing in the channel"),
  ];
  const target = store[30] ?? fact("none", "");

  test("a word most of the store holds does not name a fact; a rare one does", () => {
    const generic = namingOf("the channel setting", [target], store);
    expect(generic.shared.map((entry) => entry.word)).toEqual(["the", "channel"]);
    expect(generic.specific).toEqual([]);
    const specific = namingOf("channel unsplitfinalparam", [target], store);
    expect(specific.specific.map((entry) => entry.word)).toEqual(["unsplitfinalparam"]);
    expect(specific.judgement).toBe(true);
  });

  test("a relaxed value holds only while the search runs", async () => {
    const data = loadReplayData(synthetic());
    const env = await openEnv(null);
    try {
      const rows = await replayShape(env, "own", data.shapes.own, data.labels);
      expect(Object.keys(rows[0]?.relaxed ?? {})).toEqual(
        VARIANTS.filter((v) => v !== "vectorCutoff"),
      );
      const inside = await withRelaxed("passLimit", async () => {
        const found = await env.caller("github.com/replay/x-0", "probe")("search_facts", {
          query: "staging deploy",
          explain: true,
        });
        return (found.explain?.["profile"] as { passLimit: number }).passLimit;
      });
      const after = await env.caller("github.com/replay/x-0", "probe")("search_facts", {
        query: "staging deploy",
        explain: true,
      });
      expect(inside).toBe(100_000);
      expect((after.explain?.["profile"] as { passLimit: number }).passLimit).toBe(50);
    } finally {
      await env.close();
    }
  });
});
