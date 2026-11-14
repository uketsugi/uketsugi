import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbedError } from "@uketsugi/core";
import { installModel, openLocalEmbedder, verifyModel, type LocalEmbedder } from "@uketsugi/embed";
import { describeEmbedderConformance } from "@uketsugi/testkit";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { makeFixture, type Fixture } from "./fixture.ts";

let dir: string;
let root: string;
let fixture: Fixture;
const open: LocalEmbedder[] = [];

async function installed(config?: object): Promise<LocalEmbedder> {
  if (config !== undefined) fixture = await makeFixture(join(dir, "other"), config);
  const { catalog } = fixture;
  expect(await installModel(root, { catalog, fetch: fixture.fetch })).toMatchObject({ ok: true });
  const embedder = openLocalEmbedder(root, { catalog });
  open.push(embedder);
  return embedder;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ukt-embed-"));
  root = join(dir, "model");
  fixture = await makeFixture(join(dir, "fixture"));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((embedder) => embedder.close()));
  await rm(dir, { recursive: true, force: true });
});

describe("installing the model", () => {
  test("fetches the pinned runtime and model, keeps only this platform's binary, and verifies", async () => {
    const progress: string[] = [];
    const outcome = await installModel(root, {
      catalog: fixture.catalog,
      fetch: fixture.fetch,
      onProgress: ({ name, received, total }) => progress.push(`${name} ${received}/${total}`),
    });

    expect(outcome).toEqual({ ok: true, model: "fixture-model@test", fetched: true });
    expect(fixture.requests).toHaveLength(5);
    expect(progress).toContain("onnx/weights.bin 4096/4096");
    const binaries = await readdir(join(root, "node_modules/onnxruntime-node/bin/napi-v6"));
    expect(binaries).toEqual([process.platform]);
    expect(await readdir(root)).toEqual(["models", "node_modules"]);
    expect(await verifyModel(root, fixture.catalog)).toEqual({
      ok: true,
      model: "fixture-model@test",
    });
  });

  test("leaves a directory that already verifies alone", async () => {
    await installed();
    const before = fixture.requests.length;

    const again = await installModel(root, { catalog: fixture.catalog, fetch: fixture.fetch });

    expect(again).toMatchObject({ ok: true, fetched: false });
    expect(fixture.requests).toHaveLength(before);
  });

  test("refuses a runtime tarball that does not match its pin and keeps nothing of it", async () => {
    const [url] = [...fixture.served.keys()];
    fixture.served.set(url!, Buffer.from("not the pinned bytes"));

    const outcome = await installModel(root, { catalog: fixture.catalog, fetch: fixture.fetch });

    expect(outcome).toMatchObject({ ok: false, reason: "integrity_mismatch" });
    expect(await readdir(root)).toEqual([]);
  });

  test("refuses a model file with other bytes of the same size, and one the server lacks", async () => {
    const url = "https://models.test/rev/onnx/weights.bin";
    fixture.served.set(url, Buffer.from("x".repeat(4096)));
    const options = { catalog: fixture.catalog, fetch: fixture.fetch };
    expect(await installModel(root, options)).toMatchObject({
      ok: false,
      reason: "integrity_mismatch",
    });

    fixture.served.delete(url);
    const missing = await installModel(root, options);

    expect(missing).toMatchObject({ ok: false, reason: "fetch_failed" });
    expect(missing).toHaveProperty("detail", `${url}: the server answered 404`);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
  });
});

describe("verifying a model directory", () => {
  test("says an empty directory holds no install", async () => {
    expect(await verifyModel(root, fixture.catalog)).toMatchObject({
      ok: false,
      reason: "not_installed",
    });
  });

  test("notices a model file whose bytes changed and a runtime package of another version", async () => {
    await installed();
    const weights = join(root, "models/fixture-model/onnx/weights.bin");
    const original = await readFile(weights);
    await writeFile(weights, "W".repeat(4096));
    expect(await verifyModel(root, fixture.catalog)).toMatchObject({
      ok: false,
      reason: "changed",
      detail: expect.stringContaining("weights.bin") as string,
    });

    await writeFile(weights, original);
    const manifest = join(root, "node_modules/onnxruntime-common/package.json");
    await writeFile(manifest, JSON.stringify({ name: "onnxruntime-common", version: "9.9.9" }));

    expect(await verifyModel(root, fixture.catalog)).toMatchObject({
      ok: false,
      reason: "changed",
      detail: "onnxruntime-common is 9.9.9; the pinned version is 1.2.3",
    });
  });
});

describeEmbedderConformance("the local embedder on a fixture model", () => installed());

describe("the local embedder", () => {
  test("runs a question ahead of documents that are waiting", async () => {
    const embedder = await installed();
    const order: string[] = [];

    const documents = embedder.embed(["one", "two", "three"], "document").then(() => {
      order.push("documents");
    });
    const question = embedder.embed(["which?"], "query").then(() => {
      order.push("question");
    });
    await Promise.all([documents, question]);

    expect(order).toEqual(["question", "documents"]);
  });

  test("fails one text as retryable and still answers the next", async () => {
    const embedder = await installed();

    const failed = await embedder.embed(["explode"], "document").catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(EmbedError);
    expect(failed).toMatchObject({ retryable: true });
    expect(await embedder.embed(["fine"], "document")).toHaveLength(1);
  });

  test("replaces a worker that crashed with one new worker, and no more", async () => {
    const embedder = await installed();
    await embedder.embed(["before"], "query");

    const crashed = await embedder.embed(["crash"], "document").catch((error: unknown) => error);
    const after = await embedder.embed(["after"], "query");
    const later = await embedder.embed(["later"], "query");

    expect(crashed).toMatchObject({ name: "EmbedError", retryable: true });
    expect([after, later].map((vectors) => vectors.length)).toEqual([1, 1]);
    expect(await readFile(join(root, "models/loads"), "utf8")).toBe("xx");
  });

  test("rejects an aborted call, and every call once closed", async () => {
    const embedder = await installed();
    const abort = new AbortController();

    const pending = embedder.embed(["one", "two"], "document", abort.signal);
    abort.abort();

    await expect(pending).rejects.toMatchObject({ name: "EmbedError", retryable: true });
    await embedder.close();
    await expect(embedder.embed(["late"], "query")).rejects.toMatchObject({
      message: "the embedder is closed",
      retryable: false,
    });
  });

  test("refuses to load a directory that does not verify, and says what differs", async () => {
    const embedder = await installed();
    await writeFile(join(root, "models/fixture-model/config.json"), JSON.stringify({ dims: 9 }));

    await expect(embedder.embed(["text"], "query")).rejects.toMatchObject({
      name: "EmbedError",
      retryable: false,
      message: expect.stringContaining("config.json does not have its pinned SHA-256") as string,
    });
  });

  test("reports a model the runtime cannot load", async () => {
    const embedder = await installed({ dims: 8, refuse: true });

    await expect(embedder.load()).rejects.toMatchObject({
      name: "EmbedError",
      retryable: false,
      message: "the model did not load: the fixture model refuses to load",
    });
  });
});
