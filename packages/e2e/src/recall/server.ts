/**
 * `ukt serve` from the installed release, on a port the system assigns, with a data directory of its
 * own: never the person's install or service. With a model step, the key file is sourced by the one
 * shell that starts the server, so the key goes into that process alone (UKT_LLM_KEY) and never
 * through this suite's environment or its files; the server's model calls go through a forwarder
 * that records their usage.
 */
import { openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { start, stop } from "./process.ts";
import type { Forwarder } from "./forwarder.ts";

export interface ServerOptions {
  readonly releaseHome: string;
  readonly dataDir: string;
  readonly modelDir: string;
  readonly modelStep?: {
    readonly model: string;
    readonly keyFile: string;
    readonly forwarder: Forwarder;
  };
  readonly log: string;
}

export interface RunningServer {
  readonly port: number;
  readonly mcpUrl: string;
  stop(): Promise<void>;
}

/** The key file is sourced, its GEMINI_API_KEY exported as UKT_LLM_KEY, and the server exec'd. */
const WITH_KEY =
  '. "$1"; export UKT_LLM_KEY="${GEMINI_API_KEY:?no GEMINI_API_KEY in the key file}"; shift; exec "$@"';

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  await mkdir(options.dataDir, { recursive: true });
  const ukt = join(options.releaseHome, ".local", "bin", "ukt");
  const serve = [ukt, "serve", "--port", "0", "--json"];
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
  const lines = createInterface({ input: child.stdout ?? process.stdin });
  const exited = once(child, "close").then(() => {
    throw new Error(`the server exited before it listened (see ${options.log})`);
  });
  const [first] = (await Promise.race([once(lines, "line"), exited])) as [string];
  lines.on("line", () => undefined);
  const started = JSON.parse(first) as { data?: { mcp_url?: string } };
  const mcpUrl = started.data?.mcp_url;
  if (mcpUrl === undefined) throw new Error(`the server's first line has no mcp_url: ${first}`);
  return {
    port: Number(new URL(mcpUrl).port),
    mcpUrl,
    stop: () => stop(child),
  };
}
