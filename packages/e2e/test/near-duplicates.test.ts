import type { McpTestClient } from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PROJECT, startServer, type RunningServer } from "./running-server.ts";

describe("the near-duplicate check among many facts that share the claim's words", () => {
  let server: RunningServer;
  let client: McpTestClient;
  beforeAll(async () => {
    server = await startServer();
    client = await server.connect("near-duplicates");
  });
  afterAll(() => server.close());

  const publish = async (claim: string) => {
    const result = await client.callTool("publish_fact", {
      project: PROJECT,
      claim,
      citations: "src/billing/retry.ts:41-88",
    });
    expect(result.isError, result.text).toBe(false);
    return result.structuredContent as { id: string; similar?: { id: string }[] };
  };

  const filler = async (index: number) => {
    server.clock.advance(1_000);
    const words = "dunning retries a declined card ".repeat(8);
    await publish(
      `${words}and the ${["alpha", "beta", "gamma", "delta"][index % 4]} case ${index} differs`,
    );
  };

  test("a near-duplicate of a published claim is reported though many longer facts repeat its words", async () => {
    const target = await publish("Dunning retries a declined card on days one, three and five");
    for (let index = 0; index < 30; index++) await filler(index);
    server.clock.advance(1_000);
    const near = await publish("Dunning retries a declined card on days one, three and six");
    expect(near.similar?.map((fact) => fact.id)).toContain(target.id);

    // The word pass hands the trigram test a bounded number of facts, the ones holding most of the
    // claim's words: several hundred facts that hold half of them do not push the duplicate out.
    for (let index = 30; index < 380; index++) await filler(index);
    server.clock.advance(1_000);
    const later = await publish("Dunning retries a declined card on days one, three and seven");
    expect(later.similar?.map((fact) => fact.id)).toContain(target.id);
  }, 120_000);
});
