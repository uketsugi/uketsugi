/**
 * Cases that run side by side without touching each other: each case's requests reach its own
 * server and its own mail relay, a restart takes a port of its own, a relay that is not the case's
 * is refused, and box starts are spaced and retried.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Server } from "node:net";
import { createServer as http, type Server as Http } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Adapter, AdapterContext } from "../../src/recall/adapter.ts";
import { Case } from "../../src/recall/case.ts";
import type { ChainData } from "../../src/recall/chain.ts";
import { SERVER_PORT } from "../../src/recall/environment.ts";
import { Workspace } from "../../src/recall/workspace.ts";
import * as boxstart from "../../src/recall/boxstart.ts";

let root = "";
let workspace: Workspace;
const MAIL_PORT = 2525;
const chain = {
  helper: { name: "mail", script: "benchtests/mailrelay.py", port: MAIL_PORT },
} as unknown as ChainData;
const tools = { goroot: "", pythonBase: "" };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "recall-check-side-"));
  process.env["TMPDIR"] = root;
  workspace = await Workspace.create();
});

afterAll(async () => {
  await workspace.close();
  rmSync(root, { recursive: true, force: true });
});

/** The servers a stand-in product started, with the port each was asked for. */
const asked: number[] = [];
const servers: Http[] = [];

const standIn: Adapter = {
  name: "stand-in",
  memory: { call: [], touch: [] },
  boilerplate: [],
  configurations: ["only"],
  session: () => ({ allowedTools: "" }),
  async serve(_context, _config, dir, port) {
    asked.push(port);
    mkdirSync(join(dir, "data"), { recursive: true });
    const name = dir.split("/").at(-1) as string;
    const server = http((_req, res) => res.end(`server:${name}`));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const bound = (server.address() as { port: number }).port;
    return {
      port: bound,
      url: `http://127.0.0.1:${bound}`,
      stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
      exit: () => null,
    };
  },
  seed: () => Promise.resolve(0),
  install: () => Promise.resolve([]),
  afterSession: () => Promise.resolve(),
  readStore: () => Promise.resolve([]),
  deliveries: () => [],
};

const context = (): AdapterContext => ({ workspace, tools }) as unknown as AdapterContext;

const open = (name: string, script = "benchtests/mailrelay.py"): Promise<Case> =>
  Case.open({
    adapter: standIn,
    context: context(),
    tools,
    config: "only",
    name,
    chain: { ...chain, helper: { ...chain.helper, script } },
  });

/** What a sandbox's relay would ask the case at an inside port: a request over the unix socket of the case. */
function ask(c: Case, inside: number, path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(join(c.environment.socks, `${inside}.sock`));
    let body = "";
    socket.on("data", (d) => (body += d.toString()));
    socket.on("close", () => resolve(body.split("\r\n\r\n").at(-1) ?? ""));
    socket.on("error", () => resolve(""));
    socket.write(`GET ${path} HTTP/1.0\r\n\r\n`);
  });
}

const tokenOf = (c: Case): string | undefined =>
  (c as unknown as { relay?: { token: string } }).relay?.token;

describe("cases side by side", () => {
  test("24 cases open at once and each one's requests reach only its own server and relay", async () => {
    const cases = await Promise.all(Array.from({ length: 24 }, (_, n) => open(`c${n}`)));
    try {
      const answers = await Promise.all(
        cases.map(async (c) => ({
          server: await ask(c, SERVER_PORT, "/"),
          relay: (await ask(c, MAIL_PORT, "/token")).trim(),
        })),
      );
      cases.forEach((c, n) => {
        expect(answers[n]?.server).toBe(`server:c${n}`);
        expect(tokenOf(c)).toBeTypeOf("string");
        expect(answers[n]?.relay).toBe(tokenOf(c));
      });
      expect(new Set(cases.map((c) => tokenOf(c))).size).toBe(24);
    } finally {
      await Promise.all(cases.map((c) => c.close()));
    }
  }, 120_000);

  test("a restart takes a port of its own and the case's requests follow it", async () => {
    const c = await open("restart");
    try {
      asked.length = 0;
      await c.snapshotStore("one");
      await c.restoreStore("one");
      expect(asked).toEqual([0, 0]);
      expect(await ask(c, SERVER_PORT, "/")).toBe("server:restart");
    } finally {
      await c.close();
    }
  }, 60_000);

  test("a relay that is not the case's own is refused, and no session is pointed at it", async () => {
    const foreign: Server = createServer((socket) =>
      socket.end("HTTP/1.0 200 OK\r\n\r\nnot-your-token"),
    );
    await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
    const port = (foreign.address() as { port: number }).port;
    const script = join(root, "liar.py");
    writeFileSync(
      script,
      `import json, time\nprint(json.dumps({"port": ${port}, "token": "whatever"}), flush=True)\ntime.sleep(60)\n`,
    );
    try {
      await expect(open("foreign", script)).rejects.toThrow(/relay/);
    } finally {
      foreign.close();
    }
  }, 60_000);
});

describe("starting boxes", () => {
  test("starts are spaced 0.3 s apart", async () => {
    const at: number[] = [];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        await boxstart.spaceBoxStart();
        at.push(Date.now());
      }),
    );
    at.sort((a, b) => a - b);
    for (let i = 1; i < at.length; i++)
      expect((at[i] as number) - (at[i - 1] as number)).toBeGreaterThanOrEqual(290);
  });

  test("a start that fails on the loopback is retried three times, and a start that fails otherwise is not", async () => {
    let tries = 0;
    const flaky = await boxstart.withBoxRetries(async () => {
      tries += 1;
      return tries < 4
        ? { failed: true, stderr: "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted" }
        : { failed: false, stderr: "" };
    });
    expect(tries).toBe(4);
    expect(flaky.started).toBe(true);
    let other = 0;
    const once = await boxstart.withBoxRetries(async () => {
      other += 1;
      return { failed: true, stderr: "bwrap: execvp claude: No such file" };
    });
    expect(other).toBe(1);
    expect(once.started).toBe(true);
    let always = 0;
    const gone = await boxstart.withBoxRetries(async () => {
      always += 1;
      return { failed: true, stderr: "bwrap: loopback: Failed RTM_NEWADDR" };
    });
    expect(always).toBe(4);
    expect(gone.started).toBe(false);
  });
});
