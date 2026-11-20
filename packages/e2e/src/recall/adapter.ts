/**
 * A memory product, as the suite sees it: six functions and a table of configurations. Adding a
 * product means writing an adapter and registering it in `adapters.ts`; nothing else changes.
 *
 * Order of use for one case: `serve`, `seed`, `install` (the harness is pointed at what is serving),
 * then sessions with `afterSession` between them, `readStore` for the stored measure and `deliveries`
 * for the recalled one.
 */
import type { Environment } from "./environment.ts";
import type { Forwarder } from "./forwarder.ts";
import type { Tools } from "./preflight.ts";
import type { Release } from "./release.ts";
import type { Delivery, Transcript } from "./transcript.ts";
import type { Workspace } from "./workspace.ts";

export interface AdapterContext {
  readonly workspace: Workspace;
  readonly tools: Tools;
  readonly release: Release;
  /** The home the release was installed into: what serves is run from it. */
  readonly releaseHome: string;
  /** The model every session runs on: an alias or a full id. */
  readonly model: string;
  /** A model directory a person's `ukt setup` made (the embedding model); copied, never downloaded. */
  readonly modelDir: string;
  /** A file in shell syntax exporting GEMINI_API_KEY, for a product's own model step. Never read here. */
  readonly llmKeyFile?: string;
}

/** A product that is serving: what the harness is pointed at, and what stops it. */
export interface Serving {
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
  /** The forwarder that records the product's own model calls, when it makes any. */
  readonly modelStep?: Forwarder;
}

export interface StoredFact {
  readonly id: string;
  /** Claim, detail and question as one text. */
  readonly text: string;
  readonly by: "agent" | "model step";
  /** One of the seed's own facts. */
  readonly seed: boolean;
}

/** What a harness session is given beside the task, by configuration. */
export interface SessionRow {
  /** Tools the session may use without asking: the product's. */
  readonly allowedTools: string;
  /** Typed before each session's first task message, when the configuration has one. */
  readonly firstMessage?: string;
}

export interface InstallRecord {
  readonly cmd: readonly string[];
  readonly code: number | null;
  readonly output: string;
}

export interface Adapter {
  readonly name: string;
  /** The first is the default. */
  readonly configurations: readonly [string, ...string[]];
  session(config: string): SessionRow;
  serve(context: AdapterContext, config: string, dir: string): Promise<Serving>;
  /** Stores the seed facts by the product's own write path; returns how many. */
  seed(
    serving: Serving,
    project: string,
    facts: readonly Record<string, unknown>[],
  ): Promise<number>;
  install(
    context: AdapterContext,
    environment: Environment,
    serving: Serving,
    config: string,
    home: string,
  ): Promise<InstallRecord[]>;
  afterSession(serving: Serving): Promise<void>;
  readStore(
    serving: Serving,
    project: string,
    seedClaims: ReadonlySet<string>,
  ): Promise<StoredFact[]>;
  /** The hook outputs and tool results that count as the product delivering. */
  deliveries(transcript: Transcript, config: string): Delivery[];
}
