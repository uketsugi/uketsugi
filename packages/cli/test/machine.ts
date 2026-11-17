/**
 * A machine for the tests of set-up: a systemd user manager, as far as `ukt` runs it. It answers
 * the commands `ukt` gives the way the real manager answered in a container (systemd 249), keeps
 * what it was told, and records every command line, so a test can say what ran. Nothing of the
 * real machine is reached.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { connectInfo, hostProof } from "@uketsugi/server";
import { afterEach } from "vitest";
import type { Io, Ran } from "../src/report.ts";
import { serve } from "../src/serve.ts";
import type { SetupOptions } from "../src/setup-parts.ts";
import { fakeIo, tempDir, type FakeIoOptions } from "./support.ts";

const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "" });
const failed = (stderr: string): Ran => ({ code: 1, stdout: "", stderr });

export interface MachineOptions {
  /** The home directory of the account the test's verbs run as: its `HOME`. */
  home: string;
  /** Whether a systemd user manager answers `systemctl`, which is there and cannot connect where none does. Left out, the machine has no systemd. */
  manager?: boolean;
  /** What logind says of lingering; left out, there is no `loginctl`. */
  linger?: "yes" | "no";
}

export class Machine {
  /** Every command line that was run, as a person would type it. */
  readonly ran: string[] = [];
  enabled = false;
  running = false;
  /** Whether the manager has given up on the unit after repeated failures. */
  gaveUp = false;
  /** A `systemctl` verb that fails, for a test of a failure. */
  failing: string | null = null;
  /** What the manager does to start the unit's server, handed the unit, and to stop it: a test's own server. */
  onStart: ((unit: string) => Promise<void>) | undefined;
  onStop: (() => Promise<void>) | undefined;
  private readonly options: MachineOptions;

  constructor(options: MachineOptions) {
    this.options = options;
  }

  /** Where `ukt` writes the unit for the account of this home. */
  get unitFile(): string {
    return join(this.options.home, ".config", "systemd", "user", "uketsugi.service");
  }

  /** The command lines that changed something: everything but the questions `ukt` asks first. */
  get changes(): string[] {
    return this.ran.filter((line) => !/ show |show-user|^journalctl /.test(line));
  }

  readonly run: Io["run"] = async (program, args) => {
    this.ran.push([program, ...args].join(" "));
    if (program === "systemctl")
      return this.options.manager === undefined ? null : this.systemctl(args.slice(1));
    if (program === "loginctl")
      return this.options.linger === undefined ? null : ok(`${this.options.linger}\n`);
    return null;
  };

  private async systemctl([verb = "", ...rest]: readonly string[]): Promise<Ran> {
    if (this.options.manager !== true) return failed("Failed to connect to bus: No medium found");
    const unit = await readFile(this.unitFile, "utf8").catch(() => null);
    if (verb === "show") return ok(this.shown(unit !== null));
    if (verb === "daemon-reload") return ok();
    if (unit === null) return failed("Unit uketsugi.service not found.");
    if (this.failing === verb) return failed("Job for uketsugi.service failed.");
    await this.obey(verb, rest.includes("--now"), unit);
    return ok();
  }

  /** Stops, enables, disables and starts the unit as the verb says. */
  private async obey(verb: string, now: boolean, unit: string): Promise<void> {
    if (this.running && (now || verb === "stop" || verb === "restart")) {
      await this.onStop?.();
      this.running = false;
    }
    if (verb === "enable" || verb === "disable") this.enabled = verb === "enable";
    if (verb === "start" || verb === "restart") {
      // A server that fails to start exits at once: the manager has it not running.
      this.running =
        (await this.onStart?.(unit).then(
          () => true,
          () => false,
        )) ?? true;
    }
  }

  private shown(installed: boolean): string {
    const [active, sub] = this.running
      ? ["active", "running"]
      : this.gaveUp
        ? ["failed", "failed"]
        : ["inactive", "dead"];
    const file = installed ? (this.enabled ? "enabled" : "disabled") : "";
    return `ActiveState=${active}\nSubState=${sub}\nUnitFileState=${file}\n`;
  }
}

/** A port nothing listens on, for a server a test starts at an address it must know beforehand. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((serving) => serving.close().catch(() => undefined)));
});

/**
 * What set-up needs of a running server, without the store behind it: something at the data
 * directory's address that proves it holds the host's secret, describes what a harness sends,
 * and lists its tools. It leaves the record a server leaves. A test of what the real server
 * does starts the real one (`real`).
 */
async function standIn(dataDir: string, port: number): Promise<{ close(): Promise<void> }> {
  const url = `http://127.0.0.1:${port}`;
  const listener = createServer((request, response) => {
    const asked = new URL(request.url ?? "/", url);
    void readFile(join(dataDir, "host.key"), "utf8").then((key) => {
      const challenge = asked.searchParams.get("challenge") ?? "";
      const answer =
        asked.pathname === "/api/host-proof"
          ? { proof: hostProof(key.trim(), challenge) }
          : asked.pathname === "/api/connect"
            ? connectInfo(url, null, false)
            : { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "search_facts" }] } };
      response.setHeader("content-type", "application/json").end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => listener.listen(port, "127.0.0.1", resolve));
  await writeFile(join(dataDir, "server.json"), JSON.stringify({ url }));
  return {
    async close() {
      await rm(join(dataDir, "server.json"), { force: true });
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    },
  };
}

/**
 * A person's account on a machine of the test's own: a home, a data directory in it, a free port,
 * and what the machine has. What its manager starts, or the person "by hand" (`byHand`), is a
 * server that proves it is that data directory's: a stand-in for it, or with `real` the server
 * itself, in this process.
 */
export async function account(has: Omit<MachineOptions, "home"> & { real?: boolean } = {}) {
  const home = await tempDir();
  const dataDir = join(home, "data");
  const machine = new Machine({ home, ...has });
  const port = await freePort();
  let serving: { close(): Promise<void> } | undefined;
  const start = async (): Promise<void> => {
    serving =
      has.real === true
        ? await serve(fakeIo(), { dataDir, host: "127.0.0.1", port: String(port) }, {})
        : await standIn(dataDir, port);
    servers.push(serving);
  };
  machine.onStart = start;
  machine.onStop = async () => {
    await serving?.close();
    serving = undefined;
  };
  return {
    home,
    dataDir,
    machine,
    origin: `http://127.0.0.1:${port}`,
    env: { HOME: home, UKT_LAUNCHER: "/opt/uketsugi/bin/ukt" } as NodeJS.ProcessEnv,
    io: (options: FakeIoOptions = {}) => fakeIo({ run: machine.run, ...options }),
    /** What set-up is told: this data directory, this port, no model. */
    options: {
      dataDir,
      model: false,
      host: "127.0.0.1",
      port: String(port),
    } satisfies SetupOptions,
    /** Starts the server as a person does who runs `ukt serve` themselves. */
    byHand: start,
  };
}
