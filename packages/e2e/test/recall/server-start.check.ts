/**
 * What the suite makes of a server's start, with a stand-in for `ukt` that prints what the real one
 * prints (`ukt serve --json`): a recovery sentence before the report when it recovers its store, and
 * a report that says which model it loaded. A case must not be lost to the first, and a server that
 * loaded no model must not serve a case.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startServer, type RunningServer } from "../../src/recall/server.ts";

let root = "";
let modelDir = "";

let capabilities: Server;
/** What `/api/capabilities` answers, one answer a request, the last one for good. */
let answers: string[][] = [];
let port = 0;

const REPORT = (model: string | null): string =>
  JSON.stringify({
    ok: true,
    command: "serve",
    data: { url: `http://127.0.0.1:${port}`, mcp_url: `http://127.0.0.1:${port}/mcp`, model },
  });

/** A release home whose `ukt` prints `printed` (one line each) and then waits to be stopped. */
function release(name: string, printed: readonly string[], wait = "300"): string {
  const home = join(root, name);
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "ukt");
  const lines = printed.map((l) => `echo '${l}'`).join("\n");
  writeFileSync(script, `#!/bin/sh\n${lines}\nexec sleep ${wait}\n`);
  chmodSync(script, 0o755);
  return home;
}

const start = (
  name: string,
  printed: readonly string[],
  dir = modelDir,
  wait = "300",
): Promise<RunningServer> =>
  startServer({
    releaseHome: release(name, printed, wait),
    dataDir: join(root, name, "data"),
    modelDir: dir,
    port: 0,
    log: join(root, `${name}.log`),
  });

beforeAll(async () => {
  capabilities = createServer((_, res) => {
    const degraded = answers.length > 1 ? (answers.shift() as string[]) : (answers[0] ?? []);
    res.end(JSON.stringify({ degraded }));
  });
  await new Promise<void>((resolve) => capabilities.listen(0, "127.0.0.1", resolve));
  port = (capabilities.address() as AddressInfo).port;
  root = mkdtempSync(join(tmpdir(), "recall-check-server-"));
  modelDir = join(root, "model");
  mkdirSync(join(modelDir, "node_modules"), { recursive: true });
  mkdirSync(join(modelDir, "models"));
});

afterAll(() => {
  capabilities.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the start of a server", () => {
  test("is found after the sentence it prints first when it recovers its store", async () => {
    const server = await start("recovering", [
      "uketsugi is recovering its store after an unclean stop (a power cut, or a stop that was cut short).",
      REPORT("granite-small-r2@int8:1f4cf47e4ade"),
    ]);
    try {
      expect(server.mcpUrl).toBe(`http://127.0.0.1:${port}/mcp`);
      expect(server.port).toBe(port);
    } finally {
      await server.stop();
    }
  });

  test("is refused when the server reports no model: its search would match words only", async () => {
    await expect(start("modelless", [REPORT(null)])).rejects.toThrow(/no embedding model/);
  });

  test("is refused when the model directory is not the folder `ukt setup` makes", async () => {
    // the folder above it: it holds `model/`, not `node_modules/` and `models/`
    await expect(
      start("wrong-folder", [REPORT("granite-small-r2@int8:1f4cf47e4ade")], root),
    ).rejects.toThrow(/does not hold node_modules and models/);
  });

  test("waits while the server says its model is loading, and is refused when it then says it is unavailable", async () => {
    answers = [["embedder_loading"], ["embedder_unavailable"]];

    await expect(
      start("unavailable", [REPORT("granite-small-r2@int8:1f4cf47e4ade")]),
    ).rejects.toThrow(/degraded \(embedder_unavailable\)/);
  });

  test("is served once the model that was loading has loaded", async () => {
    answers = [["embedder_loading"], []];
    const server = await start("loaded", [REPORT("granite-small-r2@int8:1f4cf47e4ade")]);

    await server.stop();
  });

  test("is stopped when the question to the server fails, and not left running", async () => {
    capabilities.close();
    try {
      await expect(
        start("unreachable", [REPORT("granite-small-r2@int8:1f4cf47e4ade")], modelDir, "77.31"),
      ).rejects.toThrow(/fetch failed/);
      expect(execFileSync("ps", ["-eo", "args"]).toString()).not.toMatch(/^sleep 77\.31$/m);
    } finally {
      await new Promise<void>((resolve) => capabilities.listen(port, "127.0.0.1", resolve));
    }
  });
});
