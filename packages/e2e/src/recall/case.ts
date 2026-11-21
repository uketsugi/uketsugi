/**
 * One case's live parts: its sandbox environment, the forwarder to the model API, the product
 * serving (seeded, on a port the system assigns), the mail relay the chain's tasks name (started once,
 * on a port it binds itself and proves is its own), and the scratch home the harness is set up in. A
 * step of a session is `runSession` on a copy of the home. The store can be copied (`snapshotStore`)
 * and put back (`restoreStore`), so that every probe meets the store as the gap left it and no
 * probe's writing reaches another; the product comes back on a port of its own, which the sandbox's
 * relay is pointed at, so that no case holds a port it gave up.
 * `close` stops what the case started and nothing else.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Adapter, AdapterContext, InstallRecord, Serving, StoreFact } from "./adapter.ts";
import { DATA, type ChainData } from "./chain.ts";
import { Environment, MODEL_PORT, SERVER_PORT } from "./environment.ts";
import { Forwarder } from "./forwarder.ts";
import { startMailRelay, type MailRelay } from "./mailrelay.ts";
import { endWithServer, serverEnd } from "./ending.ts";
import { run } from "./process.ts";
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
  /** The case's folder, when the caller has made it (a later session's, holding the carried home and store); else one is made in the workspace. */
  readonly dir?: string;
  /** The folder already holds a set-up home and a store: nothing is installed, and nothing is seeded. */
  readonly carried?: boolean;
  /** Whether the product is given the seed facts: a run that must start from an empty store says false. */
  readonly seeded?: boolean;
}

export class Case {
  readonly dir: string;
  readonly environment: Environment;
  readonly forwarder: Forwarder;
  home = "";
  installed: readonly InstallRecord[] = [];
  serving: Serving;
  /** The chain's mail relay, when the case has a chain. */
  readonly relay: MailRelay | undefined;
  private readonly options: CaseOptions;
  private readonly steps = new Map<string, number>();

  private constructor(
    options: CaseOptions,
    dir: string,
    environment: Environment,
    forwarder: Forwarder,
    serving: Serving,
    relay: MailRelay | undefined,
  ) {
    this.options = options;
    this.dir = dir;
    this.environment = environment;
    this.forwarder = forwarder;
    this.serving = serving;
    this.relay = relay;
  }

  static async open(options: CaseOptions): Promise<Case> {
    const { adapter, context, tools, config, name } = options;
    const dir = options.dir ?? (await context.workspace.make("cases", name));
    const environment = await Environment.create(context.workspace, tools, name);
    const forwarder = await Forwarder.start(ANTHROPIC, join(dir, "requests.jsonl"));
    let serving: Serving | undefined;
    let relay: MailRelay | undefined;
    try {
      await environment.expose(MODEL_PORT, forwarder.port);
      serving = await adapter.serve(context, config, dir, 0);
      if (serving.port > 0) await environment.expose(SERVER_PORT, serving.port);
      if (options.chain !== undefined) {
        relay = await startMailRelay(resolve(DATA, "hidden", options.chain.helper.script));
        await environment.expose(options.chain.helper.port, relay.port);
      }
      if (options.seeded !== false && options.carried !== true)
        await adapter.seed(serving, PROJECT, await seedOf());
      const opened = new Case(options, dir, environment, forwarder, serving, relay);
      opened.home = join(dir, "home");
      await mkdir(opened.home, { recursive: true });
      if (options.carried !== true)
        opened.installed = await adapter.install(
          context,
          environment,
          serving,
          config,
          opened.home,
        );
      return opened;
    } catch (error) {
      await relay?.stop();
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
      ...(context.harnessMemory === true ? { harnessMemory: true } : {}),
    });
    await adapter.afterSession(this.serving);
    return { ...result, end: endWithServer(result.end, serverEnd(this.serving.exit())) };
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

  /** The product again, on a port the system assigns; the sandbox's relay is pointed at it. */
  private async startServing(): Promise<void> {
    const { adapter, context, config } = this.options;
    this.serving = await adapter.serve(context, config, this.dir, 0);
    if (this.serving.port > 0) await this.environment.expose(SERVER_PORT, this.serving.port);
  }

  async close(): Promise<void> {
    await this.relay?.stop();
    await this.serving.stop();
    await this.forwarder.stop();
    await this.environment.close();
  }
}
