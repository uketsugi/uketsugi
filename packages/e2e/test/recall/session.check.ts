/**
 * Real Claude Code sessions in the suite's sandbox, against a seeded Uketsugi built from the working
 * tree: each configuration is set up as its row says and a short session on Haiku shows it connected
 * and delivering; quick mode ends a session at its first write and still counts its tokens; no
 * credential is in what the run keeps; and the model step runs on the key file, reported in dollars.
 *
 * Needs: the sign-in (CLAUDE_CODE_OAUTH_TOKEN, or CLAUDE_SIGN_IN), UKT_MODEL_DIR, and for the model
 * step UKT_RECALL_LLM_KEY_FILE (shell syntax, exporting GEMINI_API_KEY; never read by the suite).
 * The sessions spend the sign-in's subscription; the model step spends cents.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { adapterFor } from "../../src/recall/adapters.ts";
import type { AdapterContext } from "../../src/recall/adapter.ts";
import { openCase, type OpenCase } from "../../src/recall/case.ts";
import { preflight, type Tools } from "../../src/recall/preflight.ts";
import { buildRelease, installRelease, type Release } from "../../src/recall/release.ts";
import { assertNoSecrets, signInToken } from "../../src/recall/session.ts";
import { modelStepUsd } from "../../src/recall/uketsugi.ts";
import { Workspace } from "../../src/recall/workspace.ts";

const adapter = adapterFor("uketsugi");
const ASK =
  "In one sentence: what does this project's memory say about how ChanServ greets people who join a channel? Search the memory first. Do not edit any file.";
let workspace: Workspace;
let tools: Tools;
let context: AdapterContext;
let tree = "";
const opened: OpenCase[] = [];

/** The release of the working tree, built now; or, to save the build on a rerun, the one in UKT_RECALL_RELEASE (a folder with install.sh and the tarball). */
async function releaseToUse(workspace: Workspace): Promise<Release> {
  const dir = process.env["UKT_RECALL_RELEASE"];
  if (dir === undefined) return buildRelease(workspace);
  const tarball = readdirSync(dir).find((f) => /^uketsugi-.*-linux-x64\.tar\.gz$/.test(f));
  if (tarball === undefined) throw new Error(`no release tarball in ${dir}`);
  return { dir, tarball, installScript: join(dir, "install.sh") };
}

beforeAll(async () => {
  const modelDir = process.env["UKT_MODEL_DIR"];
  if (modelDir === undefined)
    throw new Error("set UKT_MODEL_DIR to a model directory (one `ukt setup` made)");
  tools = await preflight({ sessions: true });
  workspace = await Workspace.create();
  const release = await releaseToUse(workspace);
  const releaseHome = workspace.at("ukt-home");
  await installRelease(release, releaseHome);
  const keyFile = process.env["UKT_RECALL_LLM_KEY_FILE"];
  context = {
    workspace,
    tools,
    release,
    releaseHome,
    modelDir,
    model: "haiku",
    ...(keyFile === undefined ? {} : { llmKeyFile: keyFile }),
  };
  tree = workspace.at("tree");
  mkdirSync(tree);
  writeFileSync(join(tree, "README.md"), "# ergo\n");
  execFileSync("git", ["init", "-q"], { cwd: tree });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/ergochat/ergo.git"], {
    cwd: tree,
  });
});

afterAll(async () => {
  for (const one of opened) await one.close();
  await workspace.close();
});

async function ask(one: OpenCase, config: string, prompt: string, stopAtSourceWrite = false) {
  const row = adapter.session(config);
  let resume: string | null = null;
  if (row.firstMessage !== undefined) {
    resume = (await one.session({ name: "s", tree, prompt: row.firstMessage })).sessionId;
  }
  return one.session({ name: "s", tree, prompt, resume, stopAtSourceWrite });
}

describe.each(["activate", "setup", "plugin"])("configuration %s", (config) => {
  test("is set up as its row says, and a Haiku session finds memory", async () => {
    const one = await openCase(adapter, context, tools, config, config);
    opened.push(one);

    const result = await ask(one, config, ASK);

    expect(result.setup.model).toContain("claude-haiku");
    expect(
      result.setup.mcpServers?.some((s) => /uketsugi/.test(s.name) && s.status === "connected"),
    ).toBe(true);
    if (config === "plugin")
      expect(result.setup.plugins?.some((p) => p.name === "uketsugi")).toBe(true);
    if (config === "setup") {
      expect(readFileSync(join(one.home, ".claude", "CLAUDE.md"), "utf8")).toContain("uketsugi");
    }
    const delivered = adapter.deliveries(result.transcript, config);
    const calledMemory = result.transcript.calls.some((c) => /uketsugi/.test(c.name));
    expect(delivered.length > 0 || calledMemory).toBe(true);
    expect(one.forwarder.records.length).toBeGreaterThan(0);
  });
});

describe("quick mode", () => {
  test("ends a session at its first write and still counts its tokens", async () => {
    const one = await openCase(adapter, context, tools, "activate", "quick");
    opened.push(one);

    const result = await ask(
      one,
      "activate",
      "Create a file named hello.txt in the current folder containing the word hi.",
      true,
    );

    expect(result.killed).toBe(true);
    expect(result.transcript.firstSourceWrite).toBeDefined();
    const output = one.forwarder.records.reduce((sum, r) => sum + r.usage.output, 0);
    expect(output).toBeGreaterThan(0);
  });
});

describe("what the run keeps", () => {
  test("holds no token, and a planted copy is refused", async () => {
    const one = opened[0];
    if (one === undefined) throw new Error("no case was kept");
    const token = await signInToken();

    await expect(assertNoSecrets(one.dir, [token])).resolves.toBeUndefined();
    writeFileSync(join(one.dir, "planted.txt"), `copied: ${token}\n`);
    await expect(assertNoSecrets(one.dir, [token])).rejects.toThrow(/planted\.txt/);
  });
});

describe("the model step", () => {
  test("plugin-capture runs on the key file, which the suite never holds; its spend is reported", async () => {
    if (context.llmKeyFile === undefined)
      throw new Error("set UKT_RECALL_LLM_KEY_FILE to the model step's key file");
    const one = await openCase(adapter, context, tools, "plugin-capture", "capture");
    opened.push(one);

    await ask(
      one,
      "plugin-capture",
      "Read README.md, then publish one fact about this project to memory, and tell me you did.",
    );
    await adapter.afterSession(one.serving);

    const forwarder = one.serving.modelStep;
    if (forwarder === undefined)
      throw new Error("the capture configuration has no model step forwarder");
    console.log(
      `model step: ${forwarder.records.length} calls, $${modelStepUsd(forwarder).toFixed(4)}`,
    );
    expect(forwarder.records.length).toBeGreaterThan(0);
    expect(Object.keys(process.env).filter((k) => /UKT_LLM_KEY|GEMINI_API_KEY/.test(k))).toEqual(
      [],
    );
    const found = spawnSync("grep", ["-rEl", "AIza[0-9A-Za-z_-]{20,}", one.dir]);
    expect(found.status).toBe(1);
  });
});
