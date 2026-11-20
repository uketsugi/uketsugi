/**
 * One case's live parts: its sandbox environment, the forwarder to the model API, the product
 * serving (seeded, on a port that stays the same across restarts), the mail relay the chain's tasks
 * name, and the scratch home the harness is set up in. A step of a session is `runSession` on a copy
 * of the home. The store can be copied (`snapshotStore`) and put back (`restartStore`), so that every
 * probe meets the store as the gap left it and no probe's writing reaches another.
 * `close` stops what the case started and nothing else.
 */
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Adapter, AdapterContext, InstallRecord, Serving, StoreFact } from "./adapter.ts";
import { DATA, type ChainData } from "./chain.ts";
import { Environment, MODEL_PORT, SERVER_PORT, freePort } from "./environment.ts";
import { Forwarder } from "./forwarder.ts";
import { resolveTool, run, start, stop } from "./process.ts";
import type { Tools } from "./preflight.ts";
import { runSession, type SessionOptions, type SessionResult } from "./session.ts";

const ANTHROPIC = "https://api.anthropic.com";
export const PROJECT = "github.com/ergochat/ergo";

export type StepOptions = Omit<SessionOptions, "home" | "model" | "allowedTools" | "transcript"> & {
  name: string;
};

export async function seedOf(): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(DATA, "seed.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export interface CaseOptions {
  readonly adapter: Adapter;
  readonly context: AdapterContext;
  readonly tools: Tools;
  readonly config: string;
  readonly name: string;
  readonly chain?: ChainData;
}

export class Case {
  readonly dir: string;
  readonly environment: Environment;
  readonly forwarder: Forwarder;
  home = "";
  installed: readonly InstallRecord[] = [];
  serving: Serving;
  private readonly options: CaseOptions;
  private readonly port: number;
  private readonly mailPort: number;
  private readonly steps = new Map<string, number>();

  private constructor(
    options: CaseOptions,
    dir: string,
    environment: Environment,
    forwarder: Forwarder,
    serving: Serving,
    port: number,
    mailPort: number,
  ) {
    this.options = options;
    this.dir = dir;
    this.environment = environment;
    this.forwarder = forwarder;
    this.serving = serving;
    this.port = port;
    this.mailPort = mailPort;
  }

  static async open(options: CaseOptions): Promise<Case> {
    const { adapter, context, tools, config, name } = options;
    const dir = await context.workspace.make("cases", name);
    const environment = await Environment.create(context.workspace, tools, name);
    const forwarder = await Forwarder.start(ANTHROPIC, join(dir, "requests.jsonl"));
    const mailPort = await freePort();
    let serving: Serving | undefined;
    try {
      await environment.expose(MODEL_PORT, forwarder.port);
      serving = await adapter.serve(context, config, dir, 0);
      await environment.expose(SERVER_PORT, serving.port);
      if (options.chain !== undefined)
        await environment.expose(options.chain.helper.port, mailPort);
      await adapter.seed(serving, PROJECT, await seedOf());
      const opened = new Case(
        options,
        dir,
        environment,
        forwarder,
        serving,
        serving.port,
        mailPort,
      );
      opened.home = join(dir, "home");
      await mkdir(opened.home, { recursive: true });
      opened.installed = await adapter.install(context, environment, serving, config, opened.home);
      return opened;
    } catch (error) {
      await serving?.stop();
      await forwarder.stop();
      await environment.close();
      throw error;
    }
  }

  /** Runs one step of a session; the steps of one `name` share one copy of the set-up home. */
  async session({ name, ...rest }: StepOptions): Promise<SessionResult> {
    const { adapter, context, config } = this.options;
    const sessionHome = join(this.dir, "session-homes", name);
    if (!existsSync(sessionHome)) {
      await mkdir(dirname(sessionHome), { recursive: true });
      await run("cp", ["-a", this.home, sessionHome]);
    }
    const step = this.steps.get(name) ?? 0;
    this.steps.set(name, step + 1);
    await mkdir(join(this.dir, "transcripts"), { recursive: true });
    const result = await runSession(this.environment, {
      ...rest,
      home: sessionHome,
      transcript: join(this.dir, "transcripts", `${name}.${step}.jsonl`),
      model: context.model,
      allowedTools: adapter.session(config).allowedTools,
    });
    await adapter.afterSession(this.serving);
    return result;
  }

  /** The number of the next step of a session. */
  stepOf(name: string): number {
    return this.steps.get(name) ?? 0;
  }

  /** Removes a finished session's home. */
  async dropHome(name: string): Promise<void> {
    await rm(join(this.dir, "session-homes", name), { recursive: true, force: true });
  }

  readStore(project = PROJECT): Promise<StoreFact[]> {
    return this.options.adapter.readStore(this.serving, project);
  }

  /** Stops the product, keeps a copy of its store as `snapshots/<name>`, and starts it again on its port. */
  async snapshotStore(name: string): Promise<void> {
    await this.serving.stop();
    const snapshot = join(this.dir, "snapshots", name);
    await rm(snapshot, { recursive: true, force: true });
    await mkdir(dirname(snapshot), { recursive: true });
    await run("cp", ["-a", join(this.dir, "data"), snapshot]);
    await this.startServing();
  }

  /** The store as `snapshots/<name>` kept it, in place of the one the product has now. */
  async restoreStore(name: string): Promise<void> {
    await this.serving.stop();
    await rm(join(this.dir, "data"), { recursive: true, force: true });
    await run("cp", ["-a", join(this.dir, "snapshots", name), join(this.dir, "data")]);
    await this.startServing();
  }

  private async startServing(): Promise<void> {
    const { adapter, context, config } = this.options;
    this.serving = await adapter.serve(context, config, this.dir, this.port);
  }

  /** Runs `body` with the chain's mail relay up at its inside port: a fresh relay for each session. */
  async withMailRelay<T>(chain: ChainData, body: () => Promise<T>): Promise<T> {
    const script = join(DATA, "hidden", chain.helper.script);
    const relay = start(
      resolveTool("python3") ?? "python3",
      [script, "--port", String(this.mailPort)],
      {
        stdio: "ignore",
      },
    );
    try {
      await waitForPort(this.mailPort, relay);
      return await body();
    } finally {
      await stop(relay);
    }
  }

  async close(): Promise<void> {
    await this.serving.stop();
    await this.forwarder.stop();
    await this.environment.close();
  }
}

/** Waits until something accepts connections on the port: a state, with no deadline of its own (the caller's limit guards a hang). */
async function waitForPort(port: number, process: ChildProcess): Promise<void> {
  while (process.exitCode === null && process.signalCode === null) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the mail relay ended before it listened on ${port}`);
}
