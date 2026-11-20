/**
 * One case's live parts: its sandbox environment, the forwarder to the model API, the product serving
 * (seeded), and the scratch home the harness is set up in. A session is then `runSession` on a copy of
 * the home. `close` stops what the case started and nothing else.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { run } from "./process.ts";
import type { Adapter, AdapterContext, InstallRecord, Serving } from "./adapter.ts";
import { DATA } from "./chain.ts";
import { Environment, MODEL_PORT, SERVER_PORT } from "./environment.ts";
import { Forwarder } from "./forwarder.ts";
import { runSession, type SessionOptions, type SessionResult } from "./session.ts";
import type { Tools } from "./preflight.ts";

const ANTHROPIC = "https://api.anthropic.com";
export const PROJECT = "github.com/ergochat/ergo";

export interface OpenCase {
  readonly dir: string;
  readonly environment: Environment;
  readonly forwarder: Forwarder;
  readonly serving: Serving;
  readonly home: string;
  readonly installed: readonly InstallRecord[];
  /** Runs one step of a session; the steps of one `name` share one copy of the set-up home. */
  session(
    options: Omit<SessionOptions, "home" | "model" | "allowedTools" | "transcript"> & {
      name: string;
    },
  ): Promise<SessionResult>;
  close(): Promise<void>;
}

export async function seedOf(): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(DATA, "seed.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export async function openCase(
  adapter: Adapter,
  context: AdapterContext,
  tools: Tools,
  config: string,
  name: string,
): Promise<OpenCase> {
  const dir = await context.workspace.make("cases", name);
  const environment = await Environment.create(context.workspace, tools, name);
  const forwarder = await Forwarder.start(ANTHROPIC, join(dir, "requests.jsonl"));
  let serving: Serving | undefined;
  try {
    await environment.expose(MODEL_PORT, forwarder.port);
    serving = await adapter.serve(context, config, dir);
    await environment.expose(SERVER_PORT, serving.port);
    await adapter.seed(serving, PROJECT, await seedOf());
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    const installed = await adapter.install(context, environment, serving, config, home);
    const row = adapter.session(config);
    const running = serving;
    const steps = new Map<string, number>();
    return {
      dir,
      environment,
      forwarder,
      serving: running,
      home,
      installed,
      async session({ name: sessionName, ...rest }) {
        const sessionHome = join(dir, "session-homes", sessionName);
        if (!existsSync(sessionHome)) {
          await mkdir(dirname(sessionHome), { recursive: true });
          await run("cp", ["-a", home, sessionHome]);
        }
        const step = steps.get(sessionName) ?? 0;
        steps.set(sessionName, step + 1);
        await mkdir(join(dir, "transcripts"), { recursive: true });
        const result = await runSession(environment, {
          ...rest,
          transcript: join(dir, "transcripts", `${sessionName}.${step}.jsonl`),
          home: sessionHome,
          model: context.model,
          allowedTools: row.allowedTools,
        });
        await adapter.afterSession(running);
        return result;
      },
      async close() {
        await running.stop();
        await forwarder.stop();
        await environment.close();
      },
    };
  } catch (error) {
    await serving?.stop();
    await forwarder.stop();
    await environment.close();
    throw error;
  }
}
