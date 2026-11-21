/**
 * What the suite makes of a server's start, with a stand-in for `ukt` that prints what the real one
 * prints (`ukt serve --json`): recovery event lines before the report when it recovers its store, and
 * a report that says which model it loaded. A case must not be lost to the first, and a server that
 * loaded no model must not serve a case.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  KILLED_LINE,
  RECOVERED_LINE,
  STOP_SECONDS,
  startServer,
  uncleanOf,
  type RunningServer,
} from "../../src/recall/server.ts";
import { keep, type Suite } from "../../src/recall/runner.ts";
import { headline } from "../../src/recall/report.ts";
import type { Case } from "../../src/recall/case.ts";
import { measured, resultOf } from "./world.ts";

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

const RECOVERY = (message: string): string => JSON.stringify({ event: "recovery", message });

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
  test("is found after the recovery events it prints first, and the start is counted as one recovery", async () => {
    const server = await start("recovering", [
      RECOVERY("uketsugi is recovering its store after an unclean stop."),
      RECOVERY("recovering: syncing the files: 916 of about 2175"),
      RECOVERY("recovered: done (2411 syncs)"),
      REPORT("granite-small-r2@int8:1f4cf47e4ade"),
    ]);
    try {
      expect(server.mcpUrl).toBe(`http://127.0.0.1:${port}/mcp`);
      expect(server.port).toBe(port);
      expect(uncleanOf(readFileSync(join(root, "recovering.log"), "utf8")).recovered).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test("is not counted as a recovery when no recovery event came before the report", async () => {
    const server = await start("quiet", [REPORT("granite-small-r2@int8:1f4cf47e4ade")]);
    await server.stop();

    expect(uncleanOf(readFileSync(join(root, "quiet.log"), "utf8")).recovered).toBe(0);
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

describe("the stop of a server", () => {
  /** A `ukt` that reports, then takes `slow` seconds to exit once it is told to stop, and writes `exited` when it has. */
  function slowRelease(name: string, slow: number): string {
    const home = join(root, name);
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const script = join(home, ".local", "bin", "ukt");
    writeFileSync(
      script,
      `#!/bin/sh\necho '${REPORT("granite-small-r2@int8:1f4cf47e4ade")}'\ntrap 'sleep ${slow}; echo done > "${home}/exited"; exit 0' TERM\nsleep 300 &\nwait\n`,
    );
    chmodSync(script, 0o755);
    return home;
  }
  const serve = (name: string, slow: number, stopSeconds?: number): Promise<RunningServer> =>
    startServer({
      releaseHome: slowRelease(name, slow),
      dataDir: join(root, name, "data"),
      modelDir,
      port: 0,
      log: join(root, `${name}.log`),
      ...(stopSeconds === undefined ? {} : { stopSeconds }),
    });

  test("waits for a server that takes longer than ten seconds to exit, and does not kill it", async () => {
    const server = await serve("slow", 12);
    await server.stop();

    // the stand-in writes this only once its slow exit is done: a kill before then leaves no file
    expect(existsSync(join(root, "slow", "exited"))).toBe(true);
    expect(uncleanOf(readFileSync(join(root, "slow.log"), "utf8")).killed).toBe(0);
  }, 60_000);

  test("kills a server that has not gone in the time it is given, says so, and counts it", async () => {
    const server = await serve("stuck", 30, 1);
    await server.stop();

    const log = readFileSync(join(root, "stuck.log"), "utf8");
    expect(log).toContain(KILLED_LINE);
    expect(uncleanOf(log).killed).toBe(1);
  }, 60_000);

  test("is given the time the product gives its own: the unit's STOP_SECONDS in packages/cli", () => {
    const source = readFileSync(new URL("../../../cli/src/service.ts", import.meta.url), "utf8");
    expect(source).toContain(`const STOP_SECONDS = ${STOP_SECONDS};`);
  });
});

describe("the record of a case", () => {
  test("ends with the stops that killed its server and the starts that recovered a store, and the headline says so", async () => {
    const dir = join(root, "case");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "server.log"),
      [`${KILLED_LINE}: x`, RECOVERED_LINE, `${KILLED_LINE}: y`, ""].join("\n"),
    );
    const record = measured("W1", 1);
    const served = { dir, serving: {}, close: async () => undefined } as unknown as Case;

    await keep(served, "case", { resultsDir: join(root, "results") } as Suite, record);

    expect(record.killed_stops).toBe(2);
    expect(record.recovered_starts).toBe(1);
    expect(headline(resultOf([record]))).toMatch(
      /2 stops killed the server and 1 starts recovered a store/,
    );
  });
});
