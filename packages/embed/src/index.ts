/**
 * The local embedding adapter: the pinned model catalog, its install, its verification, and the
 * `Embedder` (see `@uketsugi/core`) that runs it in a worker thread.
 */
export { CATALOG } from "./catalog.ts";
export { openLocalEmbedder, type LocalEmbedder } from "./embedder.ts";
export { isMissing } from "./faults.ts";
export { installModel } from "./install.ts";
export { verifyModel } from "./verify.ts";
