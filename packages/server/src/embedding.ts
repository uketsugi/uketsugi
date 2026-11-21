/**
 * Whether the server's embedding model loaded. The server holds an embedder object whether or not
 * its model can be loaded (a failed load stands until the process restarts), so what it says of
 * itself is what one text put through it came to, asked once when the server is composed.
 */
import type { Embedder } from "@uketsugi/core";

/** `none`: no embedder. `loading`: the first text is still going through it. */
export type EmbeddingState = "none" | "loading" | "loaded" | "failed";

const states = new WeakMap<Embedder, EmbeddingState>();

/** Puts one text through the embedder, once, to learn whether its model loads. */
export function checkEmbedder(embedder: Embedder | null): void {
  if (embedder === null || states.has(embedder)) return;
  states.set(embedder, "loading");
  // Not `embedder.embed(...)` alone: an embedder that throws, not rejects, must not stop the server.
  Promise.resolve()
    .then(() => embedder.embed(["uketsugi"], "query"))
    .then(
      () => states.set(embedder, "loaded"),
      () => states.set(embedder, "failed"),
    );
}

export function embeddingState(embedder: Embedder | null): EmbeddingState {
  checkEmbedder(embedder);
  return embedder === null ? "none" : (states.get(embedder) ?? "loading");
}
