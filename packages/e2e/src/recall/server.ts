/**
 * `ukt serve` from the installed release, on a port the system assigns, with a data directory of its
 * own: never the person's install or service. With a model step, the key file is sourced by the one
 * shell that starts the server, so the key goes into that process alone (UKT_LLM_KEY) and never
 * through this suite's environment or its files; the server's model calls go through a forwarder
 * that records their usage.
 */
import { appendFileSync, existsSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { start, stop, watchExit, type ProcessExit } from "./process.ts";
import type { Forwarder } from "./forwarder.ts";

export interface ServerOptions {
  readonly releaseHome: string;
  readonly dataDir: string;
  readonly modelDir: string;
  /** The port to listen on; 0 for one the system assigns. */
  readonly port: number;
  readonly modelStep?: {
    readonly model: string;
    readonly keyFile: string;
    readonly forwarder: Forwarder;
  };
  readonly log: string;
  /** How long a stop waits for the server before it kills it; the product's own, unless a check says otherwise. */
  readonly stopSeconds?: number;
}

export interface RunningServer {
  readonly port: number;
  readonly mcpUrl: string;
  stop(): Promise<void>;
  /** How the server ended when this run did not stop it; null while it is up or after a stop. */
  exit(): ProcessExit | null;
}

/**
 * Why a folder is not what `ukt setup` makes, or undefined when it is: the folder that directly holds
 * `node_modules/` (the runtime) and `models/` (the model), which is where the server looks
 * (`packages/embed/src/catalog.ts`, `layout`). The folder above it is not a model directory, and a
 * server given that one starts, serves, and matches words only.
 */
export function modelDirProblem(dir: string): string | undefined {
  const missing = ["node_modules", "models"].filter((name) => !existsSync(join(dir, name)));
  return missing.length === 0
    ? undefined
    : `${dir} does not hold ${missing.join(" and ")}: the model directory is the folder \`ukt setup\` makes, which holds node_modules/ and models/ itself`;
}

/** What the server's JSON report says, found among the lines it prints: it may say something else first (it recovers a store after an unclean stop, in event lines). */
function reportOf(line: string): { mcpUrl: string; model: string | null } | undefined {
  try {
    const data = (JSON.parse(line) as { data?: { mcp_url?: unknown; model?: unknown } }).data;
    if (typeof data?.mcp_url !== "string") return undefined;
    return { mcpUrl: data.mcp_url, model: typeof data.model === "string" ? data.model : null };
  } catch {
    return undefined;
  }
}

/**
 * How long the product lets its server take to stop, in seconds: `STOP_SECONDS` of `packages/cli`
 * (`service.ts`), the unit's `TimeoutStopSec`. The suite does not depend on the CLI package, so the
 * number stands here, and a check fails when the two differ. A stop on a busy disk takes as long as
 * the disk's queue of syncs allows, and a server killed before it has gone leaves a store that
 * the next start has to recover.
 */
export const STOP_SECONDS = 600;

/** What the log says, once a stop had to kill the server, and once a start recovered a store: a run counts these lines. */
export const KILLED_LINE = "suite: KILLED the server";
export const RECOVERED_LINE = "suite: the server recovered its store at start";

/** How many stops killed a server, and how many starts recovered a store, as a case's server log says. */
export function uncleanOf(log: string): { killed: number; recovered: number } {
  const lines = log.split("\n");
  return {
    killed: lines.filter((l) => l.startsWith(KILLED_LINE)).length,
    recovered: lines.filter((l) => l.startsWith(RECOVERED_LINE)).length,
  };
}

/** Whether a line of `ukt serve --json` is one of the server's recovery events: `{"event":"recovery","message":...}`, read as data and not as words. */
function isRecoveryEvent(line: string): boolean {
  try {
    return (JSON.parse(line) as { event?: unknown }).event === "recovery";
  } catch {
    return false;
  }
}

/** How long a server may say its model is still loading. */
const LOADING_SECONDS = 120;

/**
 * What the server says is left out of its answers, once its model has settled: the `degraded` list of
 * `GET /api/capabilities` (`no_model`, `embedder_unavailable`, or `embedder_loading` while the check
 * runs), empty when the model loaded. Undefined when it is empty. Each answer is written to the server's log, which a case keeps.
 */
async function degradedBy(origin: string, log: string): Promise<string[] | undefined> {
  const until = Date.now() + LOADING_SECONDS * 1000;
  for (;;) {
    const said = (await (await fetch(`${origin}/api/capabilities`)).json()) as {
      degraded?: string[];
    };
    const degraded = said.degraded ?? [];
    appendFileSync(log, `suite: /api/capabilities degraded=${JSON.stringify(degraded)}\n`);
    const loading = degraded.length === 1 && degraded[0] === "embedder_loading";
    if (degraded.length === 0) return undefined;
    if (!loading || Date.now() > until) return degraded;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The key file is sourced, its GEMINI_API_KEY exported as UKT_LLM_KEY, and the server exec'd. */
const WITH_KEY =
  '. "$1"; export UKT_LLM_KEY="${GEMINI_API_KEY:?no GEMINI_API_KEY in the key file}"; shift; exec "$@"';

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const problem = modelDirProblem(options.modelDir);
  if (problem !== undefined) throw new Error(problem);
  await mkdir(options.dataDir, { recursive: true });
  const ukt = join(options.releaseHome, ".local", "bin", "ukt");
  const serve = [ukt, "serve", "--port", String(options.port), "--json"];
  const env: Record<string, string> = {
    HOME: options.dataDir,
    PATH: "/usr/bin:/bin",
    UKT_MODEL_DIR: options.modelDir,
  };
  let command = ukt;
  let args = serve.slice(1);
  const step = options.modelStep;
  if (step !== undefined) {
    env["UKT_LLM_URL"] = `http://127.0.0.1:${step.forwarder.port}/v1beta`;
    command = "sh";
    args = ["-c", WITH_KEY, "sh", step.keyFile, ukt, ...serve.slice(1), "--llm", step.model];
  }
  const child = start(command, args, {
    env,
    stdio: ["ignore", "pipe", openSync(options.log, "a")],
  });
  const stopServer = async (): Promise<void> => {
    const seconds = options.stopSeconds ?? STOP_SECONDS;
    if ((await stop(child, "SIGTERM", seconds * 1000)).killed) {
      const said = `${KILLED_LINE}: it had not stopped in ${seconds} s, so its store needs recovery (see ${options.log})`;
      appendFileSync(options.log, `${said}\n`);
      process.stderr.write(`${said}\n`);
    }
  };
  const exit = watchExit(child);
  const lines = createInterface({ input: child.stdout ?? process.stdin });
  const exited = once(child, "close").then(() => {
    throw new Error(`the server exited before it listened (see ${options.log})`);
  });
  // Every line is read, so that the pipe never fills; the first that is the report is the start.
  let recovered = false;
  const reported = new Promise<NonNullable<ReturnType<typeof reportOf>>>((resolve) => {
    lines.on("line", (line) => {
      if (!recovered && isRecoveryEvent(line)) {
        recovered = true; // several lines tell of one recovery: the start is counted once
        appendFileSync(options.log, `${RECOVERED_LINE}\n`);
      }
      const report = reportOf(line);
      if (report !== undefined) resolve(report);
    });
  });
  const started = await Promise.race([reported, exited]);
  if (started.model === null) {
    await stopServer();
    throw new Error(
      `the server loaded no embedding model from ${options.modelDir}, so its search would match words only: this is not the product as shipped (see ${options.log})`,
    );
  }
  const degraded = await degradedBy(new URL(started.mcpUrl).origin, options.log).catch(
    async (error: unknown) => {
      await stopServer();
      throw error;
    },
  );
  if (degraded !== undefined) {
    await stopServer();
    throw new Error(
      `the server says its answers are degraded (${degraded.join(", ")}), so its search is not the product as shipped (see ${options.log})`,
    );
  }
  return {
    port: Number(new URL(started.mcpUrl).port),
    mcpUrl: started.mcpUrl,
    stop: stopServer,
    exit,
  };
}
