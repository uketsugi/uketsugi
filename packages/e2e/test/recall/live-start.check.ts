/** The run command's refusals: no reading of the seven-day window, a window too full, and N lowered by the guard, all before anything starts. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** A folder that has the two entries a model folder has: enough for the refusals, which look no further. */
function modelFolder(): string {
  const folder = join(root, "model");
  mkdirSync(join(folder, "node_modules"), { recursive: true });
  mkdirSync(join(folder, "models"), { recursive: true });
  return folder;
}

/** Times that fit any number of units up to 8, so that the refusals here are the ones under test. */
function measuredFile(): string {
  const file = join(root, "measured.json");
  const minute = 60_000;
  writeFileSync(
    file,
    JSON.stringify({
      byUnits: [
        {
          units: 8,
          setupCachedMs: 3 * minute,
          setupBuiltMs: 7 * minute,
          eFinishMs: minute,
          gapMs: minute,
          judgeMs: minute,
          lFinishMs: minute,
          settleMs: 0,
          printMs: 30_000,
        },
      ],
    }),
  );
  return file;
}

describe("the model folder", () => {
  test("is asked for at once, before the reading, the lock and the set-up, and the message says how to give one", async () => {
    delete process.env["UKT_MODEL_DIR"];
    const error = await liveRun({ units: "4", out: join(root, "never") }).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(error).toContain("pass --model-dir <folder> or set UKT_MODEL_DIR");
    expect(error).toContain("nothing has been started");
    expect(existsSync(join(root, "never"))).toBe(false);
  });

  test("a folder that is not a model folder is refused with what it lacks", async () => {
    await expect(liveRun({ units: "4", "model-dir": join(root, "no-model") })).rejects.toThrow(
      /does not hold node_modules and models/,
    );
  });
});

describe("the run command", () => {
  test("refuses to start without a reading, whether none is named or the folder holds none", async () => {
    await expect(liveRun({ units: "4", "model-dir": modelFolder() })).rejects.toThrow(
      /pass --reading-from/,
    );
    await expect(
      liveRun({ units: "4", "reading-from": join(root, "nowhere"), "model-dir": modelFolder() }),
    ).rejects.toThrow(/no reading/);
  });

  test("refuses when the window is too full for a unit", async () => {
    await expect(
      liveRun({
        units: "4",
        "reading-from": previousRun("full", 0.95),
        "model-dir": modelFolder(),
      }),
    ).rejects.toThrow(/too full/);
  });

  test("lowers the number of units to what the window leaves, and then asks for the ergo mirror", async () => {
    const said = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(
        liveRun({
          units: "8",
          "reading-from": previousRun("warm", 0.85),
          "model-dir": modelFolder(),
          measured: measuredFile(),
          out: join(root, "lowered"),
        }),
      ).rejects.toThrow(/--ergo/);
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
