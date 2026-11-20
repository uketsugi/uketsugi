/**
 * What the sandbox keeps from the person running inside it, each shown two ways: it holds in the
 * sandbox the suite uses, and it stops holding in the same sandbox with the one flag that makes it
 * hold taken out (a "mutant"). A check that still passed with its flag gone would prove nothing.
 * Needs bwrap, python3, ipcmk and the internet (the no-network check needs something to fail to reach).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { run } from "../../src/recall/process.ts";
import { serveUnixToTcp, type Relay } from "../../src/recall/relay.ts";
import { REPOSITORY } from "../../src/recall/release.ts";
import { sandboxCommand, stageSockets, type SandboxSpec } from "../../src/recall/sandbox.ts";

let root = "";
let home = "";
let tree = "";
let socks = "";
let echo: Server;
let other: Server;
let relay: Relay;
let echoPort = 0;
let otherPort = 0;
const INSIDE = 7777;
const MARKER = "recall-check-marker.jsonl";

const listening = (): Promise<[Server, number]> =>
  new Promise((resolve) => {
    const server = createServer((c) => c.end("pong"));
    server.listen(0, "127.0.0.1", () =>
      resolve([server, (server.address() as { port: number }).port]),
    );
  });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "recall-check-sandbox-"));
  [home, tree, socks] = ["home", "tree", "socks"].map((d) => join(root, d)) as [
    string,
    string,
    string,
  ];
  for (const dir of [home, tree, socks]) mkdirSync(dir);
  writeFileSync(join(root, MARKER), "the future\n");
  await stageSockets(socks);
  [echo, echoPort] = await listening();
  [other, otherPort] = await listening();
  relay = await serveUnixToTcp(join(socks, `${INSIDE}.sock`), echoPort);
});

afterAll(() => {
  relay.close();
  echo.close();
  other.close();
  rmSync(root, { recursive: true, force: true });
});

type Weaken = (args: string[]) => string[];
const without =
  (...flag: string[]): Weaken =>
  (args) => {
    const at = args.findIndex((_, i) => flag.every((f, j) => args[i + j] === f));
    return at < 0 ? args : [...args.slice(0, at), ...args.slice(at + flag.length)];
  };
const replacing =
  (from: string[], to: string[]): Weaken =>
  (args) => {
    const at = args.findIndex((_, i) => from.every((f, j) => args[i + j] === f));
    return at < 0 ? args : [...args.slice(0, at), ...to, ...args.slice(at + from.length)];
  };

async function inside(script: string, weaken: Weaken = (a) => a, spec: Partial<SandboxSpec> = {}) {
  const base = await sandboxCommand({
    home,
    tree,
    socks,
    ports: [INSIDE],
    hide: [root, REPOSITORY],
    env: {},
    cmd: ["bash", "-c", script],
    ...spec,
  });
  const done = await run(base.command, weaken(base.args), {
    env: base.env,
    allowFailure: true,
    timeout: 90_000,
    killSignal: "SIGKILL",
  });
  return { code: done.code, out: done.stdout.trim(), err: done.stderr.trim() };
}

const connect = (port: number): string =>
  `python3 -c "import socket; print(socket.create_connection(('127.0.0.1',${port}),timeout=3).recv(4))"`;

describe("each guarantee holds, and fails without its flag", () => {
  test("no network: nothing outside is reachable", async () => {
    const script = `python3 -c "import socket; socket.create_connection(('1.1.1.1',443),timeout=8)" && echo REACHED; echo END`;
    expect((await inside(script)).out).toBe("END");
    expect((await inside(script, without("--unshare-net"))).out).toContain("REACHED");
  });

  test("only the relayed ports answer, and the host's other loopback ports do not", async () => {
    // The relay inside needs a moment to listen: the held run retries until it answers (the run's own
    // limit guards a hang); the weakened runs try once, since nothing is meant to answer them.
    const once = `${connect(INSIDE)}; ${connect(otherPort)} && echo REACHED-OTHER; echo END`;
    const script = `until ${connect(INSIDE)} 2>/dev/null; do sleep 0.1; done; ${connect(otherPort)} && echo REACHED-OTHER; echo END`;
    const held = (await inside(script)).out;
    expect(held).toContain("b'pong'");
    expect(held).not.toContain("REACHED-OTHER");
    expect((await inside(once, without("--unshare-net"))).out).toContain("REACHED-OTHER");
    expect((await inside(once, (a) => a, { ports: [] })).out).not.toContain("b'pong'");
  });

  test("the repository, the workspace, the hidden tests and the person's home are absent", async () => {
    const script = [
      `for p in ${root} ${REPOSITORY} /home/jason; do [ -e "$p" ] && echo FOUND $p; done`,
      `find /tmp /home -name ${MARKER} 2>/dev/null`,
      `[ -e ${REPOSITORY}/packages/e2e/data/ergo-chain/hidden ] && echo FOUND hidden-tests`,
      "echo END",
    ].join("; ");
    expect((await inside(script)).out).toBe("END");
    expect((await inside(script, without("--tmpfs", "/tmp"))).out).toContain("FOUND");
    // the repository shown through the tmpfs, as a sandbox that forgot to hide it would
    const at = (a: string[]): number => a.indexOf("--chdir");
    const withRepository: Weaken = (args) => [
      ...args.slice(0, at(args)),
      "--ro-bind",
      REPOSITORY,
      REPOSITORY,
      ...args.slice(at(args)),
    ];
    expect((await inside(script, withRepository)).out).toContain("FOUND");
  });

  test("the rest of the disk is read-only; only the home and the tree are written", async () => {
    const script =
      "awk '$5==\"/\"{print $6}' /proc/self/mountinfo | head -1; touch /home/demo/work/ok /home/demo/ok; echo END";
    const held = await inside(script);
    expect(held.out.split("\n")[0]).toMatch(/(^|,)ro(,|$)/);
    expect(existsSync(join(tree, "ok")) && existsSync(join(home, "ok"))).toBe(true);
    const weak = await inside(script, replacing(["--ro-bind", "/", "/"], ["--bind", "/", "/"]));
    expect(weak.out.split("\n")[0]).not.toMatch(/(^|,)ro(,|$)/);
  });

  test("only the devices a harness needs", async () => {
    const script = "ls /dev | tr '\\n' ' '";
    const allowed = new Set([
      "core",
      "fd",
      "full",
      "null",
      "ptmx",
      "pts",
      "random",
      "shm",
      "stderr",
      "stdin",
      "stdout",
      "tty",
      "urandom",
      "zero",
      "console",
    ]);
    const extra = (out: string): string[] =>
      out.split(/\s+/).filter((d) => d !== "" && !allowed.has(d));
    expect(extra((await inside(script)).out)).toEqual([]);
    expect(
      extra(
        (await inside(script, replacing(["--dev", "/dev"], ["--dev-bind", "/dev", "/dev"]))).out,
      ),
    ).not.toEqual([]);
  });

  test("none of the host's processes is visible", async () => {
    const script = `ls /proc | grep -c '^[0-9]'; [ -e /proc/${process.pid} ] && echo SEEN-HOST; echo END`;
    const held = (await inside(script)).out.split("\n");
    expect(Number(held[0])).toBeLessThan(10);
    expect(held).not.toContain("SEEN-HOST");
    expect((await inside(script, without("--unshare-pid"))).out).toContain("SEEN-HOST");
  });

  test("the host's SysV IPC is not visible", async () => {
    const key = /(\d+)\s*$/.exec(execFileSync("ipcmk", ["-M", "4096"]).toString())?.[1] ?? "";
    try {
      const script = `ipcs -m | grep -c ' ${key} ' ; true`;
      expect((await inside(script)).out).toBe("0");
      expect((await inside(script, without("--unshare-ipc"))).out).toBe("1");
    } finally {
      execFileSync("ipcrm", ["-m", key]);
    }
  });

  test("no run or var folder of the host's, so none of its sockets", async () => {
    const script = "ls -A /var /run | tr '\\n' ' '";
    expect((await inside(script)).out.replace(/\/(var|run):\s*/g, "").trim()).toBe("ukt");
    expect((await inside(script, without("--tmpfs", "/run"))).out.trim()).not.toBe("ukt");
  });
});
