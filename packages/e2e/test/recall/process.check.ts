/**
 * What ends a run's children. `Workspace.close()` kills every child the run started, and once a run is
 * ending nothing new may be started (a run interrupted mid-judgement would otherwise go on to start
 * the next step while its workspace is being removed).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { start } from "../../src/recall/process.ts";
import { Workspace } from "../../src/recall/workspace.ts";

let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "recall-check-process-"));
  process.env["TMPDIR"] = root;
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("closing the workspace", () => {
  test("kills a child that is still running, and then refuses to start another", async () => {
    const workspace = await Workspace.create();
    const child = start("sleep", ["313.41"], { stdio: "ignore" });
    const ended = new Promise((resolve) => child.once("close", resolve));
    try {
      await workspace.close();
      await ended; // no timer: a correct kill always ends it, and the test's own limit guards a hang

      expect(child.signalCode ?? child.exitCode).not.toBeNull();
      expect(() => start("sleep", ["313.42"], { stdio: "ignore" })).toThrow(/the run is ending/);
    } finally {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, 30_000);
});
