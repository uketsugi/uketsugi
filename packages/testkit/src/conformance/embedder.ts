import type { Embedder } from "@uketsugi/core";
import { describe, expect, test } from "vitest";

/** What every Embedder must do: one unit-length vector of `dims` per text, the same each time. */
export function describeEmbedderConformance(
  name: string,
  make: () => Embedder | Promise<Embedder>,
): void {
  describe(`${name}: Embedder conformance`, () => {
    test("returns one unit-length vector of dims components per text, in order", async () => {
      const embedder = await make();
      const texts = [
        "invoice webhooks retry five times",
        "the gateway times out after three seconds",
      ];
      const vectors = await embedder.embed(texts, "document");
      expect(embedder.model).not.toBe("");
      expect(vectors).toHaveLength(texts.length);
      for (const vector of vectors) {
        expect(vector).toHaveLength(embedder.dims);
        expect(Math.hypot(...vector)).toBeCloseTo(1, 3);
      }
    });

    test("gives the same text the same vector, and a different text a different one", async () => {
      const embedder = await make();
      const [a, b, c] = await embedder.embed(
        ["retry policy", "retry policy", "lock ordering"],
        "document",
      );
      expect(a).toEqual(b);
      expect(a).not.toEqual(c);
    });
  });
}
