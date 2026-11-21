/**
 * What the product's brief always says is never credited as recall, and what an earlier session put
 * there is. The brief is the real one, composed by a server in this process; the instruction block is
 * the product's own text, so it cannot drift from what the suite ignores.
 */
import { createApp, createTokenIdentity, SESSION_IDLE_MS } from "@uketsugi/core";
import { BLOCK_TEXT } from "@uketsugi/contracts";
import { toolCaller } from "@uketsugi/testkit";
import { expect, test } from "vitest";
import { uketsugi } from "../../src/recall/uketsugi.ts";
import { Seed, boilerplateStarts, keptRecords } from "../../src/recall/measure.ts";
import { CLIENT, describeUseCases } from "../use-case-world.ts";

const boiler = boilerplateStarts(uketsugi.boilerplate);
const seed = new Seed([], new Set());

describeUseCases("what the suite ignores of a brief", (w) => {
  test("every line of a real brief is ignored but the facts it lists", async () => {
    const ports = w.portsWith(null);
    const app = createApp({ ...ports, identity: createTokenIdentity(ports) });
    const call = toolCaller(app, w.owner, CLIENT, "github.com/acme/boilerplate");
    await call("search_facts", { query: "q" });
    await call("publish_fact", {
      claim: "Refunds are settled nightly by the batch job",
      citations: "src/refunds.ts:9",
    });
    w.clock.advance(SESSION_IDLE_MS + 1);
    const next = await call("search_facts", { query: "refunds" });
    const brief = next.text.slice(next.text.indexOf("Session brief for"));

    const kept = keptRecords(brief, seed, boiler);

    expect(brief).toContain("Facts published while it ran:");
    expect(kept).toHaveLength(1);
    expect(kept.every((r) => r.includes("Refunds are settled nightly"))).toBe(true);
  });
});

test("the instruction block's every line is ignored, as the product writes it", () => {
  const lines = BLOCK_TEXT.split("\n").filter((l) => l.trim() !== "");

  expect(keptRecords(lines.join("\n"), seed, boiler)).toEqual([]);
});
