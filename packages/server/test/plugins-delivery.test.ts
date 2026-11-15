/**
 * How a person gets the plugins: from the folder the server ships, or from the server itself,
 * under each name the server is reached by.
 */
import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCK_TEXT, type ConnectInfo } from "@uketsugi/contracts";
import { acceptToken } from "@uketsugi/core";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { connectInfo, PLUGIN_NAME, SERVER_NAME } from "../src/connect.ts";
import { composeServer, openLocalPorts, type UketsugiServer } from "../src/index.ts";

const PLUGINS = fileURLToPath(new URL("../plugins", import.meta.url));
const SCRIPT = join(PLUGINS, "claude-code/hooks/to-server.sh");
const TOKEN = "ukt_test_token_for_the_plugins";

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
      // Antigravity writes the file that holds the token for other accounts to read: the line after closes it.
      add: 'agy mcp add --header "Authorization: Bearer $UKT_TOKEN" uketsugi http://127.0.0.1:7410/mcp\nchmod 600 ~/.gemini/config/mcp_config.json',
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

  test("the lines carry a token only where the server needs one", async () => {
    const folder = await realpath(PLUGINS);
    const ORIGIN = "http://127.0.0.1:7410";
    const without = connectInfo(ORIGIN, { folder }, false);
    const withToken = connectInfo(ORIGIN, { folder }, true);

    expect(without.needs_token).toBe(false);
    expect(JSON.stringify(without.harnesses)).not.toMatch(/Authorization|UKT_TOKEN|configure/);
    expect(without.harnesses.map(({ id, add }) => [id, add])).toEqual([
      ["claude-code", `claude mcp add --transport http --scope user ${SERVER_NAME} ${ORIGIN}/mcp`],
      ["antigravity", `agy mcp add ${SERVER_NAME} ${ORIGIN}/mcp`],
      ["codex", `codex mcp add ${SERVER_NAME} --url ${ORIGIN}/mcp`],
      ["vscode", `code --add-mcp '{"name":"${SERVER_NAME}","type":"http","url":"${ORIGIN}/mcp"}'`],
      ["cursor", `"${SERVER_NAME}": {"url": "${ORIGIN}/mcp"}`],
      ["other", `${ORIGIN}/mcp`],
    ]);
    expect(withToken.needs_token).toBe(true);
    // Each harness is given the token the way it takes one: a variable's name, or its value.
    const tokenLines = Object.fromEntries(withToken.harnesses.map(({ id, add }) => [id, add]));
    expect(tokenLines["codex"]).toBe(
      `codex mcp add ${SERVER_NAME} --url ${ORIGIN}/mcp --bearer-token-env-var UKT_TOKEN`,
    );
    expect(tokenLines["vscode"]).toContain(String.raw`\"Authorization\":\"Bearer $UKT_TOKEN\"`);
    expect(withToken.harnesses[0]?.add).toContain('--header "Authorization: Bearer $UKT_TOKEN"');
    expect(withToken.harnesses[0]?.plugin?.install).toContain("claude plugin configure");
    // The name a harness adds the server under, and so the commands it types, come from one constant.
    expect(without.harnesses[0]?.activate).toBe(`/${SERVER_NAME}:activate`);
    // Every row says how it is known.
    expect(without.harnesses.every((harness) => harness.known !== "")).toBe(true);
  });

  test("a folder whose path a shell would split is quoted in the lines the Connect page gives", async () => {
    const root = await mkdtemp(join(tmpdir(), "uketsugi plugins "));
    await cp(PLUGINS, join(root, "plugins"), { recursive: true });
    const spaced = composeServer({ ports: local.ports, pluginsDir: join(root, "plugins") });
    try {
      const asked = new Request("http://127.0.0.1/api/connect", {
        headers: { host: "127.0.0.1", authorization: `Bearer ${TOKEN}` },
      });
      const info = (await (await spaced.fetch(asked)).json()) as ConnectInfo;
      const folder = await realpath(join(root, "plugins"));
      const [claude, antigravity] = info.harnesses;
      expect(claude?.plugin?.install).toContain(` --marketplace '${folder}' --config `);
      expect(antigravity?.plugin?.install).toBe(`agy plugin install '${folder}/antigravity'`);
    } finally {
      await spaced.close();
      await rm(root, { recursive: true, force: true });
    }
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
      expect(info.harnesses.every((harness) => harness.plugin === undefined)).toBe(true);
      expect((await asked("/plugins/marketplace.json")).status).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
