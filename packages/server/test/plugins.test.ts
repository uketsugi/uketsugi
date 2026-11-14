/**
 * The plugins the server ships: that their files say what the server's own code says, that a
 * person gets them from the folder or from the server, and that the one script a hook runs sends
 * what it is handed and stays out of the session's way when anything is wrong.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BLOCK_TEXT, type ConnectInfo } from "@uketsugi/contracts";
import { acceptToken } from "@uketsugi/core";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PLUGIN_NAME, SERVER_NAME } from "../src/connect.ts";
import { composeServer, openLocalPorts, type UketsugiServer } from "../src/index.ts";

const PLUGINS = fileURLToPath(new URL("../plugins", import.meta.url));
const SCRIPT = join(PLUGINS, "claude-code/hooks/to-server.sh");
const TOKEN = "ukt_test_token_for_the_plugins";
const run = promisify(execFile);
const json = async (path: string) =>
  JSON.parse(await readFile(join(PLUGINS, path), "utf8")) as unknown;

describe("the plugins' files", () => {
  test("say what the server's code says: its names, its tools' names and the block", async () => {
    expect(await readFile(join(PLUGINS, "antigravity/rules/AGENTS.md"), "utf8")).toBe(BLOCK_TEXT);
    expect(await json("antigravity/plugin.json")).toMatchObject({ name: PLUGIN_NAME });
    const marketplace = await json(".claude-plugin/marketplace.json");
    expect(marketplace).toMatchObject({
      name: PLUGIN_NAME,
      plugins: [{ name: PLUGIN_NAME, source: "./claude-code" }],
    });
    const plugin = (await json("claude-code/.claude-plugin/plugin.json")) as {
      mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
    };
    expect(plugin).toMatchObject({ name: PLUGIN_NAME });
    expect(plugin.mcpServers).toEqual({
      [SERVER_NAME]: {
        type: "http",
        url: "${user_config.url}/mcp",
        headers: { Authorization: "Bearer ${user_config.token}" },
      },
    });
    // The hook that says which conversation a call belongs to runs before the server's tools and
    // no others: under the plugin's name for them, and under the name they have for someone who
    // had added the server by its URL before installing the plugin.
    const { hooks } = (await json("claude-code/hooks/hooks.json")) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string; args: string[] }[] }[]>;
    };
    expect(Object.keys(hooks)).toEqual(["SessionStart", "PreToolUse", "Stop", "SessionEnd"]);
    const matcher = new RegExp(`^(?:${hooks.PreToolUse?.[0]?.matcher})$`);
    const tools = [
      `mcp__plugin_${PLUGIN_NAME}_${SERVER_NAME}__search_facts`,
      `mcp__${SERVER_NAME}__claim_task`,
    ];
    expect(tools.filter((tool) => matcher.test(tool))).toEqual(tools);
    expect(
      ["Bash", "mcp__github__search", `mcp__plugin_other_${SERVER_NAME}__x`].filter((tool) =>
        matcher.test(tool),
      ),
    ).toEqual([]);
    for (const [group] of Object.values(hooks)) {
      expect(group?.hooks).toMatchObject([
        { command: "sh", args: ["${CLAUDE_PLUGIN_ROOT}/hooks/to-server.sh"] },
      ]);
    }
  });
});

describe("how a person gets the plugins", () => {
  let local: Awaited<ReturnType<typeof openLocalPorts>>;
  let server: UketsugiServer;
  /** A request as it arrives under a name, as from a proxy that ended TLS where `tls` is set. */
  const ask = (path: string, host: string, tls = false) =>
    server.fetch(
      new Request(`http://${host}${path}`, {
        headers: {
          host,
          authorization: `Bearer ${TOKEN}`,
          ...(tls ? { "x-forwarded-proto": "https" } : {}),
        },
      }),
    );
  const harnessesAt = async (host: string, tls = false) => {
    const info = (await (await ask("/api/connect", host, tls)).json()) as ConnectInfo;
    return Object.fromEntries(info.harnesses.map((harness) => [harness.id, harness]));
  };

  beforeAll(async () => {
    local = await openLocalPorts({});
    await acceptToken(local.ports, local.owner, TOKEN, "test");
    server = composeServer({
      ports: local.ports,
      pluginsDir: PLUGINS,
      allowedHosts: ["memory.example.com"],
    });
  });

  afterAll(async () => {
    await server.close();
    await local.close();
  });

  test("from another machine the server hands each plugin over as a zip, and Claude Code a marketplace file that names it", async () => {
    const listed = await ask("/plugins/marketplace.json", "memory.example.com", true);
    expect(listed.status).toBe(200);
    const marketplace = (await listed.json()) as {
      name: string;
      plugins: { name: string; source: object }[];
    };
    expect(marketplace).toMatchObject({ name: PLUGIN_NAME, plugins: [{ name: PLUGIN_NAME }] });
    expect(marketplace.plugins[0]?.source).toEqual({
      source: "archive",
      url: "https://memory.example.com/plugins/claude-code.zip",
    });

    const zip = async () => {
      const fetched = await ask("/plugins/claude-code.zip", "memory.example.com");
      expect(fetched.headers.get("content-type")).toBe("application/zip");
      return new Uint8Array(await fetched.arrayBuffer());
    };
    const bytes = await zip();
    // The same files make the same zip: Claude Code takes a changed one for a new version.
    expect(await zip()).toEqual(bytes);
    const files = unzipSync(bytes);
    expect(Object.keys(files).toSorted()).toEqual([
      ".claude-plugin/plugin.json",
      "hooks/hooks.json",
      "hooks/to-server.sh",
    ]);
    expect(strFromU8(files["hooks/to-server.sh"] ?? new Uint8Array())).toBe(
      await readFile(SCRIPT, "utf8"),
    );

    const rule = new Uint8Array(
      await (await ask("/plugins/antigravity.zip", "127.0.0.1")).arrayBuffer(),
    );
    expect(strFromU8(unzipSync(rule)["rules/AGENTS.md"] ?? new Uint8Array())).toBe(BLOCK_TEXT);
    expect((await ask("/plugins/other.zip", "127.0.0.1")).status).toBe(404);
  });

  test("the Connect page gives the folder to someone on the host and the server's own address to anyone else", async () => {
    const folder = await realpath(PLUGINS);
    const here = await harnessesAt("127.0.0.1:7410");
    expect(here["claude-code"]?.plugin).toEqual({
      install: `claude plugin install uketsugi --marketplace ${folder} --config url=http://127.0.0.1:7410\nprintf '{"token":"%s"}' "$UKT_TOKEN" | claude plugin configure uketsugi@uketsugi --values-stdin`,
      remove: "claude plugin marketplace remove uketsugi",
      adds_server: true,
    });
    expect(here["antigravity"]).toMatchObject({
      add: 'agy mcp add --header "Authorization: Bearer $UKT_TOKEN" uketsugi http://127.0.0.1:7410/mcp',
      plugin: { install: `agy plugin install ${folder}/antigravity`, adds_server: false },
    });
    expect(here["other"]?.plugin).toBeUndefined();

    const away = await harnessesAt("memory.example.com", true);
    expect(away["claude-code"]?.plugin?.install).toContain(
      "claude plugin install uketsugi --marketplace https://memory.example.com/plugins/marketplace.json --config url=https://memory.example.com\n",
    );
    expect(away["antigravity"]?.plugin?.install).toBe(
      "curl -fsSL https://memory.example.com/plugins/antigravity.zip -o uketsugi-antigravity.zip\nunzip -o uketsugi-antigravity.zip -d uketsugi-antigravity\nagy plugin install uketsugi-antigravity",
    );
    // Claude Code fetches a plugin from a server over TLS only: without it, the person adds the server by its URL.
    const plain = await harnessesAt("memory.example.com");
    expect(plain["claude-code"]?.plugin).toBeUndefined();
    expect(plain["claude-code"]?.add).toContain("claude mcp add --transport http");
    expect(plain["antigravity"]?.plugin?.install).toContain(
      "http://memory.example.com/plugins/antigravity.zip",
    );
  });

  test("a server with no folder of plugins offers none and serves none", async () => {
    const bare = composeServer({ ports: local.ports });
    const asked = (path: string) =>
      bare.fetch(
        new Request(`http://127.0.0.1${path}`, {
          headers: { host: "127.0.0.1", authorization: `Bearer ${TOKEN}` },
        }),
      );
    try {
      const info = (await (await asked("/api/connect")).json()) as ConnectInfo;
      expect(info.harnesses.map((harness) => harness.plugin)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      expect((await asked("/plugins/marketplace.json")).status).toBe(404);
    } finally {
      await bare.close();
    }
  });
});

describe("the script a hook runs", () => {
  interface Received {
    readonly path: string;
    readonly headers: IncomingMessage["headers"];
    readonly body: string;
  }
  const received: Received[] = [];
  let answer = { status: 200, body: "{}" };
  let url = "";
  let work = "";
  const listener = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ path: request.url ?? "", headers: request.headers, body });
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(answer.body);
    });
  });

  /** Runs the script as Claude Code runs a hook: its input on standard input, the plugin's options in the environment. */
  function hook(input: string, options: { url?: string; token?: string } = {}) {
    return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const child = spawn("sh", [SCRIPT], {
        env: {
          PATH: process.env["PATH"],
          CLAUDE_PROJECT_DIR: work,
          CLAUDE_PLUGIN_OPTION_URL: options.url ?? `${url}/`,
          CLAUDE_PLUGIN_OPTION_TOKEN: options.token ?? TOKEN,
        },
        stdio: ["pipe", "pipe", "inherit"],
      });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out }));
      // A script that ends before it reads its input closes the pipe under the writer.
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    });
  }

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "uketsugi-hook-"));
    await run("git", ["init", "-q", work]);
    // A remote with a password in it, as some are written.
    const origin = "https://ann:hunter2@github.com/acme/billing-service.git";
    await run("git", ["-C", work, "remote", "add", "origin", origin]);
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => listener.close(resolve));
    await rm(work, { recursive: true, force: true });
  });

  test("sends its input as it came, with the token and the directory's origin, and prints the server's answer", async () => {
    const input = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "c-1",
      note: 'a "quoted" word',
    });
    answer = {
      status: 200,
      body: '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The brief."}}',
    };
    const { code, out } = await hook(input);
    expect(code).toBe(0);
    expect(out).toBe(answer.body);
    expect(received.at(-1)).toMatchObject({
      path: "/api/hooks/claude-code",
      body: input,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        // The remote's password stays on the person's machine.
        "x-uketsugi-origin": "https://github.com/acme/billing-service.git",
      },
    });
  });

  test("stays out of the session's way: a server that refuses, one that is not there and a plugin not yet set up all end in nothing", async () => {
    answer = { status: 401, body: '{"error":{"code":"unauthorized"}}' };
    expect(await hook("{}")).toEqual({ code: 0, out: "" });
    answer = { status: 500, body: "no" };
    expect(await hook("{}")).toEqual({ code: 0, out: "" });
    const before = received.length;
    expect(await hook("{}", { url: "http://127.0.0.1:9" })).toEqual({ code: 0, out: "" });
    expect(await hook("{}", { token: "" })).toEqual({ code: 0, out: "" });
    expect(received).toHaveLength(before);
  });
});
