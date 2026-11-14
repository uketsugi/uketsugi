/**
 * Proves the adapter makes the vectors the search values were measured on: every text of the
 * record the retrieval benchmark runs on (`packages/e2e/data/team-memory`) is embedded again, with
 * the real model, and compared with its recorded vector.
 *
 * The tolerance: each vector's cosine with its record is at least 0.9999. The cut-off search
 * applies to a cosine is 0.78, and a different runtime moved cosines by up to 0.013, so 0.0001 is
 * far inside what matters and still catches a wrong pooling, precision or runtime.
 *
 * Needs UKT_MODEL_DIR (a model directory). UKT_RECORDED_VECTORS names another record in the same
 * format. See deploy/vitest.config.js for how to run it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG, openLocalEmbedder, type LocalEmbedder } from "@uketsugi/embed";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const RECORD =
  process.env["UKT_RECORDED_VECTORS"] ??
  fileURLToPath(new URL("../../e2e/data/team-memory", import.meta.url));
const TOLERANCE = 0.0001;

interface Record {
  readonly header: { embedModel: string; dims: number; pooling: string };
  /** `<kind>\0<text>`, in the order of the vectors. */
  readonly keys: string[];
}

function cosine(a: Float32Array, b: Float32Array): number {
  let [dot, aa, bb] = [0, 0, 0];
  for (const [i, x] of a.entries()) {
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return dot / Math.sqrt(aa * bb);
}

describe("the local embedder against the recorded vectors", () => {
  let embedder: LocalEmbedder;
  let record: Record;
  let vectors: Float32Array;

  beforeAll(async () => {
    const modelDir = process.env["UKT_MODEL_DIR"];
    if (modelDir === undefined) throw new Error("set UKT_MODEL_DIR to a model directory");
    record = JSON.parse(await readFile(join(RECORD, "vectors.json"), "utf8")) as Record;
    const blob = await readFile(join(RECORD, "vectors.f32"));
    vectors = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    embedder = openLocalEmbedder(modelDir);
    await embedder.load();
  });

  afterAll(() => embedder.close());

  test("is the model, width and pooling the record was made with", () => {
    expect(record.header).toMatchObject({
      embedModel: embedder.model,
      dims: embedder.dims,
      pooling: CATALOG.pooling,
    });
    expect(vectors).toHaveLength(record.keys.length * embedder.dims);
  });

  test("reproduces every recorded vector within the tolerance", async () => {
    const { dims } = embedder;
    let [worstCosine, worstDifference, identical] = [1, 0, 0];
    for (const [row, key] of record.keys.entries()) {
      const split = key.indexOf("\0");
      const kind = key.slice(0, split) === "query" ? "query" : "document";
      const [made] = await embedder.embed([key.slice(split + 1)], kind);
      const recorded = vectors.subarray(row * dims, (row + 1) * dims);
      if (made === undefined) throw new Error(`no vector for row ${row}`);
      const difference = made.reduce(
        (most, x, i) => Math.max(most, Math.abs(x - (recorded[i] ?? 0))),
        0,
      );
      worstCosine = Math.min(worstCosine, cosine(made, recorded));
      worstDifference = Math.max(worstDifference, difference);
      if (difference === 0) identical += 1;
    }
    console.log(
      `${record.keys.length} texts: ${identical} bit-identical; lowest cosine ${worstCosine}; largest component difference ${worstDifference}`,
    );
    expect(record.keys.length).toBeGreaterThanOrEqual(300);
    expect(1 - worstCosine).toBeLessThanOrEqual(TOLERANCE);
  });
});
