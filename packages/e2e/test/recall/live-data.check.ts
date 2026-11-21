/** The live test's data file: its prompts replace chain.json's T1 and T2 for the live test, and `told` names every item once. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DATA, loadChain } from "../../src/recall/chain.ts";
import { loadItems } from "../../src/recall/items.ts";
import { ITEMS, TOLD, loadLiveChain, toldProblem } from "../../src/live/data.ts";

describe("live.json", () => {
  test("the live chain has the reworded T1 and T2 and every other task as the recall suite has it", async () => {
    const [chain, live] = [await loadChain(), await loadLiveChain()];
    const file = JSON.parse(await readFile(join(DATA, "live.json"), "utf8")) as Record<
      string,
      { prompt: string }
    >;
    expect(live.tasks["T1"]?.prompt).toBe(file["T1"]?.prompt);
    expect(live.tasks["T1"]?.prompt).not.toBe(chain.tasks["T1"]?.prompt);
    expect(live.tasks["T2"]?.prompt).toBe(file["T2"]?.prompt);
    expect(live.tasks["T4"]).toEqual(chain.tasks["T4"]);
    expect(live.tasks["T1"]?.testCmd).toEqual(chain.tasks["T1"]?.testCmd);
  });

  test("how each item is said names exactly the five live items, each with a kind, and every one is an item of the chain", async () => {
    expect(toldProblem(TOLD, ITEMS)).toBeUndefined();
    expect([...ITEMS].sort()).toEqual(["D1", "D2", "D3", "D8", "P1"]);
    const items = await loadItems();
    for (const item of ITEMS) expect(items[item]).toBeDefined();
    expect(TOLD).toMatchObject({
      P1: "outright",
      D2: "outright",
      D1: "passing",
      D3: "passing",
      D8: "found",
    });
  });

  test("a shape that is wrong is named", () => {
    expect(toldProblem({ P1: "loudly" }, ["P1"])).toMatch(/kinds that are not/);
    expect(toldProblem({ P1: "outright" }, ["P1", "D1"])).toMatch(/missing D1/);
    expect(toldProblem({ P1: "outright", X9: "found" }, ["P1"])).toMatch(/extra X9/);
  });
});
