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
import type { ProcessExit } from "./process.ts";
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
  /** Whether the harness's sessions keep Claude Code's own memory, as a person's do. */
  readonly harnessMemory?: boolean;
  /** A file in shell syntax exporting GEMINI_API_KEY, for a product's own model step. Never read here. */
  readonly llmKeyFile?: string;
}

/** A product that is serving: what the harness is pointed at, and what stops it. */
export interface Serving {
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
  /** How the product ended when this run did not stop it; null while it is up, after a stop, and for a product with no server. */
  exit(): ProcessExit | null;
  /** The forwarder that records the product's own model calls, when it makes any. */
  readonly modelStep?: Forwarder;
}

/** A fact of a product's store as it is kept in the evidence (what Uketsugi's `/api/facts` returns of it). */
export interface StoreFact {
  readonly id: string;
  readonly claim: string;
  readonly detail?: string | null;
  readonly question?: string | null;
  /** Set when the product's own capture wrote it, not an agent. */
  readonly from_session?: string | null;
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

/** Which tool calls are the product's: names, a tool search naming it, and strings that touch its files or skills. */
export interface MemorySpec {
  readonly call: readonly string[];
  readonly toolSearch?: string;
  readonly touch: readonly string[];
}

const TOUCH_KEYS = new Set([
  "command",
  "Command",
  "CommandLine",
  "cmd",
  "file_path",
  "path",
  "Path",
  "AbsolutePath",
  "SearchPath",
  "Directory",
  "directory",
  "TargetFile",
  "notebook_path",
  "skill",
]);

/** Whether a tool call is the product's memory call (a result of one is a delivery). */
export function isMemoryCall(
  spec: MemorySpec,
  name: string,
  input: Readonly<Record<string, unknown>>,
): boolean {
  if (spec.call.some((p) => new RegExp(p).test(name))) return true;
  if (
    spec.toolSearch !== undefined &&
    name === "ToolSearch" &&
    new RegExp(spec.toolSearch).test(JSON.stringify(input))
  )
    return true;
  return Object.entries(input).some(
    ([k, v]) =>
      TOUCH_KEYS.has(k) && typeof v === "string" && spec.touch.some((p) => new RegExp(p).test(v)),
  );
}

export interface Adapter {
  readonly name: string;
  /** What counts as the product's own memory calls. */
  readonly memory: MemorySpec;
  /** Lines the product's brief always carries, which no earlier session put there. */
  readonly boilerplate: readonly string[];
  /** The first is the default. */
  readonly configurations: readonly [string, ...string[]];
  session(config: string): SessionRow;
  serve(context: AdapterContext, config: string, dir: string, port: number): Promise<Serving>;
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
  /** Every fact the product holds for the project, as `/api/facts` returns it. The store lives in `<dir>/data`, which the runner copies between sessions. */
  readStore(serving: Serving, project: string): Promise<StoreFact[]>;
  /** The hook outputs and tool results that count as the product delivering. */
  deliveries(transcript: Transcript): Delivery[];
}

/** The deliveries of a transcript by a product's memory calls: every hook's output, and the result of each call that is memory's. */
export function deliveriesBy(spec: MemorySpec, transcript: Transcript): Delivery[] {
  return transcript.deliveries.filter(
    (d) => d.via === "hook" || isMemoryCall(spec, d.name, d.input),
  );
}
