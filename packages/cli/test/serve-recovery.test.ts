import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually } from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  copyOf,
  held,
  heldBy,
  opening,
  removeMade,
  writeUntilKilled,
  type Held,
} from "../../store/test/support/processes.ts";
import { doctor } from "../src/doctor.ts";
import { fakeIo, unusedPort } from "./support.ts";

/**
 * `ukt serve` on a store that was killed answers from the start and obeys a stop. Each case runs
 * the real command as a child on a copy of one killed store, under the preload that records and
 * holds every sync (`store/test/support/hold-syncs.ts`), so what happens while a recovery sync is
 * held is read from the log, and nothing waits on a clock.
 */
const everything = 1_000_000;
const CLI = join(import.meta.dirname, "..", "src", "index.ts");

let killed: string;
let acknowledged: string[];

beforeAll(async () => {
  killed = await mkdtemp(join(tmpdir(), "uketsugi-serve-killed-"));
  acknowledged = await writeUntilKilled(killed, (ids) => ids.length === 12);
});
afterAll(async () => {
  await removeMade();
  await rm(killed, { recursive: true, force: true });
});

interface Server {
  readonly run: Held;
  readonly url: string;
  readonly dataDir: string;
}

/** `ukt serve` on a copy of the killed store, its port kept in the data directory's settings as `ukt setup` keeps it. */
async function serving(dataDir: string, holdAll = true, flags: string[] = []): Promise<Server> {
  const port = await unusedPort();
  await writeFile(
    join(dataDir, "settings.json"),
    JSON.stringify({ host: "127.0.0.1", port: String(port) }),
  );
  const run = await held([CLI, "serve", "--data-dir", dataDir, ...flags], holdAll);
  return { run, url: `http://127.0.0.1:${port}`, dataDir };
}

/** What a request is answered, or "refused" where nothing listens. */
type Answer =
  { status: number; retryAfter: string | null; body: Record<string, unknown> } | "refused";
async function ask(url: string, path: string, init?: RequestInit): Promise<Answer> {
  try {
    const response = await fetch(`${url}${path}`, init);
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, retryAfter: response.headers.get("retry-after"), body };
  } catch {
    return "refused";
  }
}

/** Waits for the banner: the server is started, so a stop closes its store. A stop before that ends the process with the store open. */
const bannerOf = (run: Held): Promise<void> =>
  eventually(() => {
    if (!run.lines.some((line) => line.startsWith("uketsugi is serving")))
      throw new Error("no banner");
  });

/** Waits until the process has ended or its main thread has turned twice since "signal sent". */
const turnedTwiceOrEnded = (run: Held): Promise<void> =>
  eventually(() => {
    const log = run.log();
    const sent = log.indexOf("signal sent");
    if (!run.over && log.slice(sent).filter((line) => line === "tick").length < 2)
      throw new Error("the main thread has not turned twice yet");
  });

/** The health answer once it reports `n` syncs done; at once where nothing answers. */
const healthAt = (server: Server, n: number): Promise<Answer> =>
  eventually(async () => {
    const answer = await ask(server.url, "/healthz");
    if (answer !== "refused" && answer.body["synced"] !== n)
      throw new Error("not at that sync yet");
    return answer;
  });

describe("ukt serve on a killed store", () => {
  test("answers while recovery syncs are held, says so, and serves on the same listener after", async () => {
    const server = await serving(await copyOf(killed));
    const { run } = server;
    expect(await heldBy(run, 1)).toBe("worker");
    const first = await healthAt(server, 0);
    const said = run.lines.join("\n");
    run.release(2);
    await heldBy(run, 3);
    const second = await healthAt(server, 2);
    const mcp = await ask(server.url, "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const report = await doctor(fakeIo(), { dataDir: server.dataDir }, {});
    const finding = (report.data["findings"] as { check: string; detail: string }[]).find(
      (found) => found.check === "server",
    );
    run.release(everything);
    const serves = await eventually(async () => {
      const answer = await ask(server.url, "/healthz");
      if (answer === "refused" || answer.status !== 200) throw new Error("not serving yet");
      return answer;
    });
    await bannerOf(run);
    run.child.kill("SIGTERM");
    await run.ended;

    expect(first).toMatchObject({
      status: 503,
      retryAfter: "5",
      body: { status: "recovering", phase: "syncing", synced: 0 },
    });
    expect(second).toMatchObject({
      status: 503,
      body: { status: "recovering", phase: "syncing", synced: 2 },
    });
    expect(mcp).toMatchObject({ status: 503, body: { jsonrpc: "2.0", id: 1 } });
    expect(JSON.stringify(mcp)).toContain("recovering its store after an unclean stop: syncing");
    expect(finding?.detail).toContain(
      "recovering its store after an unclean stop: syncing the store's files: 2 of about",
    );
    expect(serves.status).toBe(200);
    // The recovering line came before any sync was let go, the banner after the recovery.
    expect(said).toContain("uketsugi is recovering its store after an unclean stop");
    const lines = run.lines;
    const at = (start: string): number => lines.findIndex((line) => line.startsWith(start));
    expect(at("uketsugi is recovering")).toBeLessThan(at("recovered:"));
    expect(at("recovered:")).toBeLessThan(at("uketsugi is serving"));
  });

  test("with --json every line is JSON: the recovery is told as an event and the report is the one envelope; a stop with SIGTERM leaves the store clean", async () => {
    const dataDir = await copyOf(killed);
    const { run } = await serving(dataDir, false, ["--json"]);
    run.release(everything);
    await eventually(() => {
      if (!run.lines.some((line) => line.includes('"mcp_url"'))) throw new Error("no report");
    });
    run.child.kill("SIGTERM");
    await run.ended;

    const parsed = run.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const events = parsed.filter((line) => line["event"] !== undefined);
    const reports = parsed.filter((line) => line["ok"] !== undefined);
    expect(events.map((event) => event["event"])).toContain("recovery");
    expect(String(events[0]?.["message"])).toContain("recovering its store after an unclean stop");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ ok: true, command: "serve" });
    // The stop was SIGTERM and not a kill: the store was closed, so the next start has no recovery to tell.
    const control = await readFile(join(dataDir, "pg", "global", "pg_control"));
    expect(control.readUInt32LE(16)).toBe(1);

    const next = await serving(dataDir, false, ["--json"]);
    next.run.release(everything);
    await eventually(() => {
      if (!next.run.lines.some((line) => line.includes('"mcp_url"'))) throw new Error("no report");
    });
    next.run.child.kill("SIGTERM");
    await next.run.ended;
    expect(next.run.lines.filter((line) => line.includes('"event"'))).toEqual([]);
  });

  describe.each(["SIGTERM", "SIGINT"] as const)(
    "a stop (%s) while a recovery sync is held",
    (signal) => {
      test("ends the process before the sync is let go, and the next start serves every fact", async () => {
        const dataDir = await copyOf(killed);
        const server = await serving(dataDir);
        const { run } = server;
        run.release(2);
        const thread = await heldBy(run, 3);
        run.mark("signal sent");
        run.child.kill(signal);
        // Where the main thread is held in a sync it cannot act on the signal, and where it turns
        // twice after the signal is sent it has had its chance: either way the answer is in.
        if (thread === "worker") await turnedTwiceOrEnded(run);
        const endedBeforeRelease = run.over;
        if (!endedBeforeRelease) {
          run.release(everything);
          run.child.kill("SIGKILL");
        }
        await run.ended;

        expect(thread).toBe("worker");
        expect(endedBeforeRelease).toBe(true);

        const next = await serving(dataDir, false);
        next.run.release(everything);
        await bannerOf(next.run);
        next.run.child.kill("SIGTERM");
        await next.run.ended;
        const after = await opening(dataDir);
        after.release(everything);
        await after.ended;
        const facts = after
          .said()
          .flatMap((said) => (said["facts"] === undefined ? [] : (said["facts"] as string[])));
        expect(after.said().some((said) => said["progress"] !== undefined)).toBe(false);
        expect(facts).toEqual(expect.arrayContaining(acknowledged));
      });
    },
  );

  test("a stop that comes as soon as the store is open closes it, so it is left clean", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "uketsugi-serve-stop-"));
    const driver = join(import.meta.dirname, "stop-at-open.ts");
    const child = spawn(process.execPath, ["--conditions=@uketsugi/source", driver, dataDir], {
      stdio: "inherit",
    });
    const [code] = (await once(child, "exit")) as [number | null];
    const control = await readFile(join(dataDir, "pg", "global", "pg_control"));
    await rm(dataDir, { recursive: true, force: true });

    expect(code).toBe(0);
    expect(control.readUInt32LE(16)).toBe(1);
  });
});
