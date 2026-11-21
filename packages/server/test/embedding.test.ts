/** What the server says of whether its embedding model loaded: `/api/capabilities`' `degraded`. */
import { EmbedError, type Embedder } from "@uketsugi/core";
import { eventually } from "@uketsugi/testkit";
import { expect, test } from "vitest";
import { composeServer, openLocalPorts } from "../src/index.ts";

/** The `degraded` a server with this embedder (or none) tells once it has settled. */
async function degradedOf(embedder: Embedder | null): Promise<string[]> {
  const local = await openLocalPorts(embedder === null ? {} : { embedder });
  const server = composeServer({ ports: local.ports });
  const { url } = await server.listen({ port: 0 });
  try {
    return await eventually(async () => {
      const described = (await (await fetch(`${url}/api/capabilities`)).json()) as {
        degraded: string[];
      };
      expect(described.degraded).not.toEqual(["embedder_loading"]);
      return described.degraded;
    });
  } finally {
    await server.close();
    await local.close();
  }
}

const embeds = (embed: Embedder["embed"]): Embedder => ({ model: "m", dims: 4, embed });

test("a server with no model says so", async () => {
  expect(await degradedOf(null)).toEqual(["no_model"]);
});

test("a server whose model loads says nothing is missing", async () => {
  const loads = embeds((texts) => Promise.resolve(texts.map(() => new Float32Array(4))));
  expect(await degradedOf(loads)).toEqual([]);
});

test("a server whose model did not load says that, though it holds an embedder", async () => {
  const fails = embeds(() =>
    Promise.reject(new EmbedError("the model could not be loaded", false)),
  );
  expect(await degradedOf(fails)).toEqual(["embedder_unavailable"]);
});

test("a server whose model is still loading says so, and answers meanwhile", async () => {
  const never = embeds(() => new Promise(() => undefined));
  const local = await openLocalPorts({ embedder: never });
  const server = composeServer({ ports: local.ports });
  const { url } = await server.listen({ port: 0 });
  try {
    const described = (await (await fetch(`${url}/api/capabilities`)).json()) as {
      degraded: string[];
    };
    expect(described.degraded).toEqual(["embedder_loading"]);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  } finally {
    await server.close();
    await local.close();
  }
});

test("an embedder that throws instead of rejecting does not stop the server, and counts as not loaded", async () => {
  const throws = embeds(() => {
    throw new Error("boom");
  });
  expect(await degradedOf(throws)).toEqual(["embedder_unavailable"]);
});

test("a server whose model is not the one that made the store's vectors says so", async () => {
  const loads = embeds((texts) => Promise.resolve(texts.map(() => new Float32Array(4))));
  const local = await openLocalPorts({ embedder: loads });
  const server = composeServer({ ports: local.ports });
  const { url } = await server.listen({ port: 0 });
  const degraded = async (): Promise<string[]> =>
    ((await (await fetch(`${url}/api/capabilities`)).json()) as { degraded: string[] }).degraded;
  try {
    // Another server, of another model, takes the store after this one started.
    await local.ports.store.jobs.embedMissing(loads.model, new Date());
    await eventually(async () => expect(await degraded()).toEqual([]));
    await local.ports.store.jobs.embedMissing("another-model", new Date());
    expect(await degraded()).toEqual(["embedder_not_the_stores"]);
  } finally {
    await server.close();
    await local.close();
  }
});
