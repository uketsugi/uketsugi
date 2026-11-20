/**
 * The sandbox a session or a judgement runs in: a bubblewrap command line that leaves it nothing to
 * find of the owner's or of the run's:
 * - `/` read-only, and a tmpfs over /home, /tmp, /run and /var, so the workspace, the repository, other
 *   trees and the person's home do not exist inside (a workspace elsewhere gets a tmpfs of its own);
 * - the scratch home at /home/demo, the tree at /home/demo/work, the socket folder at /run/ukt, and
 *   nothing else writable;
 * - a network namespace with loopback only. What the command may reach comes in over unix sockets
 *   (relay.ts), so the hidden tests the chain keeps on the disk cannot be fetched or read by a session;
 * - bwrap's own minimal /dev, and pid and IPC namespaces of their own, so none of the host's processes,
 *   devices or SysV IPC are there;
 * - `--die-with-parent`: the sandbox ends with the suite.
 */
import { copyFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTool } from "./process.ts";

const HIDDEN = ["/home", "/tmp", "/run", "/var"];
export const HOME = "/home/demo";
export const TREE = `${HOME}/work`;
export const SOCKETS = "/run/ukt";

export interface Bind {
  readonly from: string;
  readonly to: string;
}

export interface SandboxSpec {
  readonly home: string;
  readonly tree: string;
  readonly socks: string;
  /** Loopback ports inside, each answered by `<socks>/<port>.sock`. */
  readonly ports: readonly number[];
  /** Folders to hide that none of the four tmpfs cover: the workspace and the repository, wherever they are. */
  readonly hide: readonly string[];
  readonly readOnly?: readonly Bind[];
  readonly writable?: readonly Bind[];
  /** The harness program, bound at /home/demo/.local/bin/claude. */
  readonly claude?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cmd: readonly string[];
}

export interface Command {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

const BASE_ENV = {
  HOME,
  PATH: `${HOME}/.local/bin:/usr/bin:/bin`,
  TERM: "xterm-256color",
  LANG: "C.UTF-8",
  USER: "demo",
  LOGNAME: "demo",
  SHELL: "/bin/bash",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** The relay never sees the sign-in: `env -u` takes it out of the one process that has no use for it. */
const RELAYS = `env -u CLAUDE_CODE_OAUTH_TOKEN ${SOCKETS}/node ${SOCKETS}/relay-inside.ts $RELAY_PORTS & "$@"; rc=$?; kill $! 2>/dev/null; exit $rc`;

/** Puts into the socket folder what the sandbox runs from it: the relay's script and a node to run it. */
export async function stageSockets(socks: string): Promise<void> {
  await copyFile(
    fileURLToPath(new URL("./relay-inside.ts", import.meta.url)),
    join(socks, "relay-inside.ts"),
  );
}

const hidden = (path: string): boolean =>
  HIDDEN.some((h) => path === h || path.startsWith(`${h}/`));

export async function sandboxCommand(spec: SandboxSpec): Promise<Command> {
  const args = [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    ...HIDDEN.flatMap((path) => ["--tmpfs", path]),
  ];
  for (const path of spec.hide) {
    const real = await realpath(path);
    if (!hidden(real)) args.push("--tmpfs", real);
  }
  args.push("--bind", spec.home, HOME, "--bind", spec.tree, TREE, "--bind", spec.socks, SOCKETS);
  args.push("--ro-bind", await realpath(process.execPath), `${SOCKETS}/node`);
  if (spec.claude !== undefined) args.push("--ro-bind", spec.claude, `${HOME}/.local/bin/claude`);
  for (const bind of spec.readOnly ?? []) args.push("--ro-bind", bind.from, bind.to);
  for (const bind of spec.writable ?? []) args.push("--bind", bind.from, bind.to);
  const relays = spec.ports.map((port) => `${port}:${SOCKETS}/${port}.sock`).join(" ");
  args.push("--chdir", TREE, "sh", "-c", RELAYS, "sh", ...spec.cmd);
  return {
    command: resolveTool("bwrap") ?? "bwrap",
    args,
    env: { ...BASE_ENV, ...spec.env, RELAY_PORTS: relays },
  };
}
