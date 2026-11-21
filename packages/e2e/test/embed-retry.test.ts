/** A fact whose embedding failed is not left without a vector for good: the next start tries it again. */
import { EmbedError, type Embedder } from "@uketsugi/core";
import { expect, test } from "vitest";
import { describeUseCases } from "./use-case-world.ts";

describeUseCases("a fact whose embedding failed", (w) => {
  test("is embedded by the next start's first pass", async () => {
    // A model that verified and then did not load: every embedding it is asked for fails for good.
    const broken: Embedder = {
      model: w.embedder.model,
      dims: w.embedder.dims,
      embed: () => Promise.reject(new EmbedError("the model did not load", false)),
    };
    const published = await w.callsOn(w.portsWith(broken))("publish_fact", {
      claim: "The gateway times out after three seconds",
      citations: "src/gateway.ts:9",
    });
    await w.runJobs(w.portsWith(broken));
    expect((await w.factOf(published.id)).embedded).toBe(false);
    expect((await w.store.jobs.counts()).dead).toBeGreaterThan(0);

    // The next start, with the model working: its first pass owes this fact a vector.
    await w.runJobs(w.portsWith(w.embedder));
    expect((await w.factOf(published.id)).embedded).toBe(true);
    expect(await w.store.jobs.counts()).toMatchObject({ waiting: 0, dead: 0 });
  });
});
