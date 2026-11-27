/**
 * The install acceptance test: what "one-script install" means. A release is built from this
 * workspace, installed by its install script into an empty home directory with no `node` on the
 * PATH, set up, served, and called as a harness calls it. Everything the installed `ukt` runs
 * with is in that home and a folder of a dozen basic tools.
 *
 * `pnpm smoke` runs it, and nothing else, from the workspace root: one command from the source to a
 * tool call. With UKT_MODEL_DIR (a model directory) the embedding model is set up and used as well;
 * without it set-up leaves the model out, so nothing is downloaded. See deploy/vitest.config.js.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { connectMcp } from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Envelope } from "../src/report.ts";

const run = promisify(execFile);
const WORKSPACE = fileURLToPath(new URL("../../..", import.meta.url));
const RELEASE = join(WORKSPACE, "deploy", "dist");
/** What the install script and the launcher call, and nothing else: no `node`, no package manager. */
const TOOLS = ["sh", "uname", "dirname", "mkdir", "cp", "rm", "mv", "tar", "gzip", "sha256sum"];
const MORE_TOOLS = ["sed", "chmod"];
const PROJECT = "github.com/acme/billing-service";
/** A model directory to set up with, where there is one; without, the model is left out. */
const modelDir = process.env["UKT_MODEL_DIR"];
const WITH_MODEL = modelDir === undefined ? ["--no-model"] : [];
const MODEL_LEFT_OUT = modelDir === undefined;

describe("the release, installed by its script into an empty home with no node", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let ukt: string;
  let serving: ChildProcess | undefined;
  let installed = "";

  const envelope = async (...args: string[]): Promise<Envelope> =>
    JSON.parse((await run(ukt, [...args, "--json"], { env })).stdout) as Envelope;

  beforeAll(async () => {
    await run(join(WORKSPACE, "deploy", "build.sh"), [], { maxBuffer: 64 * 1024 * 1024 });
    root = await mkdtemp(join(tmpdir(), "ukt-install-"));
    const [home, tools] = [join(root, "home"), join(root, "tools")];
    await mkdir(home);
    await mkdir(tools);
    for (const tool of [...TOOLS, ...MORE_TOOLS]) {
      const { stdout } = await run("sh", ["-c", `command -v ${tool}`]);
      await symlink(stdout.trim(), join(tools, tool));
    }
    ukt = join(home, ".local", "bin", "ukt");
    env = { HOME: home, PATH: `${join(home, ".local", "bin")}:${tools}` };
    if (modelDir !== undefined) env["UKT_MODEL_DIR"] = modelDir;
    const script = join(RELEASE, "install.sh");
    installed = (await run(join(tools, "sh"), [script], { env })).stdout;
  });

  afterAll(async () => {
    if (serving !== undefined && serving.exitCode === null) {
      serving.kill("SIGTERM");
      await once(serving, "exit");
    }
    await rm(root, { recursive: true, force: true });
  });

  test("has no node to fall back on, and wrote only the release and the command", async () => {
    const lookup = await run("sh", ["-c", "command -v node || echo none"], { env });

    expect(lookup.stdout.trim()).toBe("none");
    expect(installed).toContain("Installed uketsugi");
    expect(installed).toContain("Next: ukt setup");
    expect(await readdir(join(root, "home"))).toEqual([".local"]);
    expect((await readdir(join(root, "home", ".local"))).sort()).toEqual(["bin", "lib"]);
    // The licence and the notice travel with every copy of the release.
    const shipped = await readdir(join(root, "home", ".local", "lib", "uketsugi"));
    expect(shipped).toEqual(expect.arrayContaining(["LICENSE", "NOTICE"]));
    // So do the plugins, at the path a person gives their harness.
    const plugins = join(root, "home", ".local", "lib", "uketsugi", "plugins");
    expect((await readdir(plugins)).sort()).toEqual([
      ".claude-plugin",
      "antigravity",
      "claude-code",
    ]);
    expect((await run(ukt, ["--version"], { env })).stdout.trim()).toMatch(
      /^\d+\.\d+\.\d+(\+\w+)?$/,
    );
  });

  test("sets up: a data directory, a token and the verified model", async () => {
    const setup = await envelope("setup", ...WITH_MODEL);

    expect(setup).toMatchObject({
      ok: true,
      data: {
        data_dir: join(root, "home", ".local", "share", "uketsugi"),
        created: { data_dir: true, token: true },
        model: { state: MODEL_LEFT_OUT ? "skipped" : "present" },
      },
    });
  });

  test("serves, and answers a tool call made as a harness makes it", async () => {
    serving = spawn(ukt, ["serve", "--port", "0", "--json"], {
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const lines = createInterface({ input: serving.stdout ?? process.stdin });
    const [first] = (await once(lines, "line")) as [string];
    const started = JSON.parse(first) as Envelope;
    const token = (await run(ukt, ["token"], { env })).stdout.trim();
    const client = await connectMcp({ url: String(started.data?.["mcp_url"]), token });

    const published = await client.callTool("publish_fact", {
      project: PROJECT,
      claim: "Invoice webhooks retry five times with exponential backoff",
      citations: ["src/webhooks/retry.ts:10-42"],
    });
    const found = await client.callTool("search_facts", {
      project: PROJECT,
      query: "webhooks retry backoff",
    });
    await client.close();

    // The installed server finds the release's plugins and hands them out by its own address.
    const base = String(started.data?.["mcp_url"]).replace(/\/mcp$/, "");
    const marketplace = await fetch(`${base}/plugins/marketplace.json`);
    expect(await marketplace.json()).toMatchObject({
      plugins: [{ name: "uketsugi", source: { source: "archive" } }],
    });

    expect(started).toMatchObject({
      ok: true,
      data: { model: MODEL_LEFT_OUT ? null : (expect.any(String) as string) },
    });
    expect(published.isError).toBe(false);
    expect(found.structuredContent).toMatchObject({ matched: 1, shown: 1 });
    expect(found.text).toContain("Invoice webhooks retry five times");
  });

  test("passes its own doctor", async () => {
    const doctor = await envelope("doctor");

    expect(doctor.ok).toBe(true);
    // Every check a new install can pass passes; the model's is a warning only where it was left out.
    expect(doctor.data?.["findings"]).toEqual(
      expect.arrayContaining(
        ["data directory", "token", "server", "store", "model"].map((check): unknown =>
          expect.objectContaining({
            check,
            state: check === "model" && MODEL_LEFT_OUT ? "warn" : "ok",
          }),
        ),
      ),
    );
  });
});
