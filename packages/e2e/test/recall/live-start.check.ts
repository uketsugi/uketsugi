/** The run command's refusals: no reading of the seven-day window, a window too full, and N lowered by the guard, all before anything starts. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { liveRun, manifestFolders } from "../../src/live/start.ts";

let root = "";
beforeAll(() => (root = mkdtempSync(join(tmpdir(), "recall-check-live-start-"))));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A kept run whose newest transcript holds a rate-limit event at `utilization`. */
function previousRun(name: string, utilization: number): string {
  const folder = join(root, name);
  mkdirSync(join(folder, "cases", "u1-memory-E", "transcripts"), { recursive: true });
  writeFileSync(
    join(folder, "cases", "u1-memory-E", "transcripts", "E.0.jsonl"),
    JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 99999999999,
        utilization,
        isUsingOverage: false,
      },
    }) + "\n",
  );
  return folder;
}

describe("the run command", () => {
  test("refuses to start without a reading, whether none is named or the folder holds none", async () => {
    await expect(liveRun({ units: "4" })).rejects.toThrow(/pass --reading-from/);
    await expect(liveRun({ units: "4", "reading-from": join(root, "nowhere") })).rejects.toThrow(
      /no reading/,
    );
  });

  test("refuses when the window is too full for a unit", async () => {
    await expect(
      liveRun({ units: "4", "reading-from": previousRun("full", 0.95) }),
    ).rejects.toThrow(/too full/);
  });

  test("lowers the number of units to what the window leaves, before the machine is looked at", async () => {
    const said = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(
        liveRun({
          units: "8",
          "reading-from": previousRun("warm", 0.85),
          "model-dir": join(root, "no-model"),
        }),
      ).rejects.toThrow(/embedding model/);
      expect(said).toHaveBeenCalledWith("units lowered from 8 to 3 by the utilisation guard");
    } finally {
      said.mockRestore();
    }
  });
});

describe("what the manifest covers", () => {
  test("the chain's data, the live shape's code and the shared code it runs on", () => {
    const folders = manifestFolders().map((f) => f.split("/").slice(-2).join("/"));
    expect(folders).toEqual(
      ["e2e/data/ergo-chain".split("/").slice(-2).join("/"), "src/live", "src/recall"].map(
        (x) => x,
      ),
    );
  });
});
