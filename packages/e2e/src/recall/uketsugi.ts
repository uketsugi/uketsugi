/**
 * The Uketsugi adapter: the product built from the working tree, connected as its README tells a
 * person to connect Claude Code. A configuration is a row:
 * - `activate` (the default): the harness is given the address (`claude mcp add`) and the first message
 *   of each session is the typed `/mcp__uketsugi__activate`;
 * - `setup`: the address, and `/mcp__uketsugi__setup` typed once before the sessions, which has the agent
 *   write the block into its `~/.claude/CLAUDE.md`;
 * - `plugin`: the plugin from the release's marketplace, configured with the address;
 * - `plugin-capture`: the plugin with capture on, and the server's model step.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  Adapter,
  AdapterContext,
  InstallRecord,
  Serving,
  SessionRow,
  StoredFact,
} from "./adapter.ts";
import { SERVER_PORT, type Environment } from "./environment.ts";
import { Forwarder } from "./forwarder.ts";
import { startServer } from "./server.ts";
import { runSession } from "./session.ts";
import type { Delivery } from "./transcript.ts";
import { connectMcp } from "@uketsugi/testkit";

const MODEL_STEP = "google/gemini-3.1-flash-lite";
const GOOGLE = "https://generativelanguage.googleapis.com";
const ADDRESS = `http://127.0.0.1:${SERVER_PORT}`;
const MARKETPLACE = "/home/demo/.local/lib/uketsugi/plugins";
const RELEASE_AT = "/run/release";

const ROWS: Record<string, SessionRow> = {
  activate: { allowedTools: "mcp__uketsugi", firstMessage: "/mcp__uketsugi__activate" },
  setup: { allowedTools: "mcp__uketsugi" },
  plugin: { allowedTools: "mcp__plugin_uketsugi_uketsugi" },
  "plugin-capture": { allowedTools: "mcp__plugin_uketsugi_uketsugi" },
};

const MEMORY_TOOL = /^mcp__(plugin_uketsugi_)?uketsugi__/;

/** The model step's prices, dollars per million tokens (handoff/tools/benefit/prices.json, `llm`). */
const PRICE = { input: 0.25, cache: 0.25, output: 1.5 };

/** What the model step spent, from the usage its forwarder recorded. Reported, never enforced. */
export function modelStepUsd(forwarder: Forwarder): number {
  let dollars = 0;
  for (const { usage } of forwarder.records) {
    dollars +=
      ((usage.input + usage.cache_write) * PRICE.input +
        usage.cache_read * PRICE.cache +
        usage.output * PRICE.output) /
      1e6;
  }
  return dollars;
}

const addCommand = [
  "claude",
  "mcp",
  "add",
  "--transport",
  "http",
  "--scope",
  "user",
  "uketsugi",
  `${ADDRESS}/mcp`,
];

/** The commands of a configuration's set-up, run in the sandbox as the person of the home. */
function installCommands(config: string): string[][] {
  const install = ["sh", `${RELEASE_AT}/install.sh`, "--tarball", "<tarball>"];
  const plugin = [
    "claude",
    "plugin",
    "install",
    "uketsugi",
    "--marketplace",
    MARKETPLACE,
    "--config",
    `url=${ADDRESS}`,
  ];
  if (config === "plugin") return [install, plugin];
  if (config === "plugin-capture") return [install, [...plugin, "--config", "capture=true"]];
  return [addCommand];
}

async function seedFacts(
  serving: Serving,
  project: string,
  facts: readonly Record<string, unknown>[],
): Promise<number> {
  const client = await connectMcp({ url: `${serving.url}/mcp` });
  try {
    for (const [index, fact] of facts.entries()) {
      const result = await client.callTool("publish_fact", { project, ...fact });
      if (result.isError)
        throw new Error(`seed fact ${index + 1} refused: ${result.text.slice(0, 300)}`);
    }
  } finally {
    await client.close();
  }
  return facts.length;
}

async function listFacts(serving: Serving, project: string): Promise<Record<string, unknown>[]> {
  const found: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({
      project,
      limit: "100",
      ...(cursor === null ? {} : { cursor }),
    });
    const response = await fetch(`${serving.url}/api/facts?${query.toString()}`);
    const page = (await response.json()) as {
      facts: Record<string, unknown>[];
      next: string | null;
    };
    found.push(...page.facts);
    cursor = page.next;
  } while (cursor !== null);
  return found;
}

/** Waits until the model step has made its digest of every recent entry, at most `seconds`. */
async function waitForDigests(serving: Serving, seconds: number): Promise<void> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try {
      const activity = (await (await fetch(`${serving.url}/api/activity`)).json()) as {
        recent?: { digest?: { at?: string } | null }[];
      };
      const rows = activity.recent ?? [];
      if (rows.length > 0 && rows.every((r) => r.digest?.at !== undefined)) return;
    } catch {
      // the server is busy: ask again
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

async function setUp(
  context: AdapterContext,
  environment: Environment,
  config: string,
  home: string,
  tree: string,
): Promise<InstallRecord[]> {
  const records: InstallRecord[] = [];
  const readOnly = [{ from: context.release.dir, to: RELEASE_AT }];
  for (const template of installCommands(config)) {
    const cmd = template.map((c) =>
      c === "<tarball>" ? `${RELEASE_AT}/${context.release.tarball}` : c,
    );
    const done = await environment.exec({ home, tree, cmd, claude: true, readOnly });
    const record = { cmd, code: done.code, output: (done.stdout + done.stderr).slice(-400) };
    records.push(record);
    if (done.code !== 0) throw new Error(`set-up failed: ${cmd.join(" ")}\n${record.output}`);
  }
  return records;
}

export const uketsugi: Adapter = {
  name: "uketsugi",
  configurations: ["activate", "setup", "plugin", "plugin-capture"],

  session(config) {
    const row = ROWS[config];
    if (row === undefined) throw new Error(`uketsugi has no configuration ${config}`);
    return row;
  },

  async serve(context, config, dir) {
    const capture = config === "plugin-capture";
    if (capture && context.llmKeyFile === undefined) {
      throw new Error("plugin-capture needs the model step's key: pass --llm-key-file");
    }
    const forwarder = capture ? await Forwarder.start(GOOGLE, join(dir, "llm.jsonl")) : undefined;
    const server = await startServer({
      releaseHome: context.releaseHome,
      dataDir: join(dir, "data"),
      modelDir: context.modelDir,
      log: join(dir, "server.log"),
      ...(forwarder === undefined || context.llmKeyFile === undefined
        ? {}
        : { modelStep: { model: MODEL_STEP, keyFile: context.llmKeyFile, forwarder } }),
    });
    return {
      port: server.port,
      url: `http://127.0.0.1:${server.port}`,
      stop: async () => {
        await server.stop();
        await forwarder?.stop();
      },
      ...(forwarder === undefined ? {} : { modelStep: forwarder }),
    };
  },

  seed: seedFacts,

  async install(context, environment, _serving, config, home) {
    const tree = join(dirname(home), "setup-tree");
    await mkdir(tree, { recursive: true });
    const records = await setUp(context, environment, config, home, tree);
    if (config === "setup") {
      await runSession(environment, {
        home,
        tree,
        prompt: "/mcp__uketsugi__setup",
        model: context.model,
        allowedTools: "mcp__uketsugi,Read,Edit,Write",
        permissionMode: "bypassPermissions",
        transcript: join(dirname(home), "setup.jsonl"),
      });
    }
    return records;
  },

  async afterSession(serving) {
    if (serving.modelStep !== undefined) await waitForDigests(serving, 300);
  },

  async readStore(serving, project, seedClaims) {
    return (await listFacts(serving, project)).map((fact): StoredFact => {
      const claim = typeof fact["claim"] === "string" ? fact["claim"] : "";
      const text = [claim, fact["detail"], fact["question"]]
        .filter((p) => typeof p === "string")
        .join("\n");
      return {
        id: String(fact["id"]),
        text,
        by:
          fact["from_session"] === null || fact["from_session"] === undefined
            ? "agent"
            : "model step",
        seed: seedClaims.has(claim),
      };
    });
  },

  deliveries(transcript) {
    return transcript.deliveries.filter(
      (d: Delivery) => d.via === "hook" || (d.via === "tool" && MEMORY_TOOL.test(d.name)),
    );
  },
};
