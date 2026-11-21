/**
 * The server a replay runs on: the product's own request pipeline over an in-memory store, with the
 * local embedding model loaded or none. A fixed clock and counted ids make every run break ties the
 * same way. Nothing here is the replay's own search: a search is a `search_facts` call.
 */
import type { SearchFactsResult } from "@uketsugi/contracts";
import {
  createApp,
  createWorker,
  scopeOf,
  type CorePorts,
  type Embedder,
  type ReadScope,
} from "@uketsugi/core";
import { openLocalEmbedder, type LocalEmbedder } from "@uketsugi/embed";
import { openLocalPorts } from "@uketsugi/server";
import { FakeClock, FakeIdGen, toolCaller, type ToolCaller } from "@uketsugi/testkit";

const STARTS_AT = new Date("2026-11-20T09:00:00.000Z");
/** The most facts a search shows, and the most its explanation lists. */
export const SEARCH_LIMIT = 50;

export interface ReplayEnv {
  readonly ports: CorePorts;
  readonly scope: ReadScope;
  /** The calls of one client in one project. A client name is a session. */
  caller(project: string, client: string): ToolCaller;
  /** Runs the follow-up jobs as a server does; throws when one failed. */
  drain(): Promise<void>;
  close(): Promise<void>;
  readonly model: boolean;
}

/**
 * Loads the pinned model from a directory. A directory that cannot serve it is an error: an arm that
 * says "with the model" must have run with it.
 */
export async function loadModel(modelDir: string): Promise<LocalEmbedder> {
  const embedder = openLocalEmbedder(modelDir);
  const check = await embedder.check();
  if (!check.ok) {
    await embedder.close();
    throw new Error(`the model is not usable in ${modelDir}: ${check.reason}, ${check.detail}`);
  }
  await embedder.load();
  return embedder;
}

/** Opens the server with the given embedder, or with none. */
export async function openEnv(
  embedder: (Embedder & { close?(): Promise<void> }) | null,
): Promise<ReplayEnv> {
  const local = await openLocalPorts({});
  const ports = {
    ...local.ports,
    clock: new FakeClock(STARTS_AT),
    ids: new FakeIdGen(),
    embedder,
  };
  const app = createApp(ports);
  return {
    ports,
    scope: scopeOf(local.owner),
    model: embedder !== null,
    caller: (project, client) =>
      toolCaller(app, local.owner, { name: client, version: null, conversationId: null }, project),
    async drain() {
      const failed: string[] = [];
      const onFailure = (job: { kind: string }, error: unknown) =>
        failed.push(`${job.kind}: ${String(error)}`);
      const worker = createWorker(ports, { onFailure });
      while ((await worker.drain()) > 0);
      if (failed.length > 0) throw new Error(`${failed.length} jobs failed: ${failed[0] ?? ""}`);
    },
    async close() {
      await local.close();
      await embedder?.close?.();
    },
  };
}

/** A search as an agent sends it, with the ranking's reasoning. */
export async function searchExplained(
  call: ToolCaller,
  query: string,
): Promise<SearchFactsResult & { readonly text: string }> {
  return call("search_facts", { query, limit: SEARCH_LIMIT, explain: true });
}
