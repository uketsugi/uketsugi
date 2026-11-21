/**
 * What one case's sessions run in: a socket folder whose relays carry the model API and the memory
 * server in over unix sockets, and the sandbox command lines that reach them at fixed loopback ports
 * (the server at 127.0.0.1:7410, which is the README's address, the model API at 7420). Outside, each
 * case's server and forwarder take a port the system assigns, so cases can run side by side.
 */
import { join } from "node:path";
import { withBoxRetries } from "./boxstart.ts";
import { run, type Finished } from "./process.ts";
import type { Tools } from "./preflight.ts";
import { REPOSITORY } from "./release.ts";
import { serveUnixToTcp, type Relay } from "./relay.ts";
import { sandboxCommand, stageSockets, type Bind, type Command } from "./sandbox.ts";
import type { Workspace } from "./workspace.ts";

export const SERVER_PORT = 7410;
export const MODEL_PORT = 7420;

export interface Invocation {
  readonly home: string;
  readonly tree: string;
  readonly cmd: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Binds the harness program in. */
  readonly claude?: boolean;
  readonly readOnly?: readonly Bind[];
}

export class Environment {
  readonly socks: string;
  private readonly workspace: Workspace;
  private readonly tools: Tools;
  /** The relay that answers each inside port. */
  private readonly relays = new Map<number, Relay>();

  private constructor(workspace: Workspace, tools: Tools, socks: string) {
    this.workspace = workspace;
    this.tools = tools;
    this.socks = socks;
  }

  static async create(workspace: Workspace, tools: Tools, name: string): Promise<Environment> {
    const socks = await workspace.make("socks", name);
    await stageSockets(socks);
    return new Environment(workspace, tools, socks);
  }

  /**
   * Makes the host's `127.0.0.1:<hostPort>` reachable inside at `127.0.0.1:<inside>`. Exposing an inside
   * port again (the server restarted on a port of its own) points it at the new host port.
   */
  async expose(inside: number, hostPort: number): Promise<void> {
    this.relays.get(inside)?.close();
    this.relays.set(inside, await serveUnixToTcp(join(this.socks, `${inside}.sock`), hostPort));
  }

  command(invocation: Invocation): Promise<Command> {
    return sandboxCommand({
      home: invocation.home,
      tree: invocation.tree,
      socks: this.socks,
      ports: [...this.relays.keys()],
      hide: [this.workspace.path, REPOSITORY],
      ...(invocation.readOnly === undefined ? {} : { readOnly: invocation.readOnly }),
      ...(invocation.claude === true && this.tools.claude !== undefined
        ? { claude: this.tools.claude }
        : {}),
      env: invocation.env ?? {},
      cmd: invocation.cmd,
    });
  }

  /** Runs a command to its end in the sandbox. */
  async exec(invocation: Invocation): Promise<Finished> {
    const sandbox = await this.command(invocation);
    let finished!: Finished;
    await withBoxRetries(async () => {
      finished = await run(sandbox.command, sandbox.args, { env: sandbox.env, allowFailure: true });
      return { failed: finished.code !== 0, stderr: finished.stderr };
    });
    return finished;
  }

  async close(): Promise<void> {
    for (const relay of this.relays.values()) relay.close();
    this.relays.clear();
  }
}
