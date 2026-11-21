/**
 * A model directory's worth of fixtures: three small runtime tarballs (a stand-in for
 * transformers.js that makes vectors from a hash of the text), a model of two files, the catalog
 * that pins them, and a `fetch` that serves them from memory.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CATALOG } from "@uketsugi/embed";
import ssri from "ssri";
import { create } from "tar";

type Catalog = typeof CATALOG;

/**
 * The stand-in runtime: it needs the sharp stub to import, reads the model's config, notes each
 * load in `models/loads` along with the telemetry switch as the process's real environment holds it
 * (what the native runtime reads, which a worker's `process.env` is not) in `models/switch`, and
 * runs one text. The text "crash" ends its worker thread.
 */
const FAKE_TRANSFORMERS = `
import "sharp";
import { appendFileSync, readFileSync } from "node:fs";
export const env = { allowRemoteModels: true, localModelPath: "" };
export async function pipeline(task, model) {
  const config = JSON.parse(readFileSync(env.localModelPath + model + "/config.json", "utf8"));
  if (config.refuse === true) throw new Error("the fixture model refuses to load");
  appendFileSync(env.localModelPath + "loads", "x");
  appendFileSync(env.localModelPath + "switch", String(process.report.getReport().environmentVariables.ORT_DISABLE_TELEMETRY));
  return async ([text]) => {
    if (text === "explode") throw new Error("the fixture model refuses this text");
    if (text === "crash") return new Promise(() => setTimeout(() => { throw new Error("the fixture worker crashes"); }));
    const data = new Float32Array(config.dims);
    for (let i = 0; i < text.length; i++) data[(i * 7 + text.charCodeAt(i)) % config.dims] += 1 + (i % 3);
    const norm = Math.hypot(...data) || 1;
    return { dims: [1, config.dims], data: data.map((value) => value / norm) };
  };
}
`;

async function tarball(dir: string, name: string, files: Record<string, string>): Promise<Buffer> {
  const source = join(dir, "src", name);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), text);
  }
  const file = join(dir, `${name.replace("/", "-")}.tgz`);
  await create({ gzip: true, cwd: source, prefix: "package", file }, Object.keys(files));
  return readFile(file);
}

export interface Fixture {
  readonly catalog: Catalog;
  /** Every URL fetched so far. */
  readonly requests: string[];
  /** What a URL serves; replace an entry to serve other bytes, delete one to answer 404. */
  readonly served: Map<string, Buffer>;
  readonly fetch: (url: string) => Promise<Response>;
}

/** Builds the fixtures under `dir`. `config` is the model's `config.json`. */
export async function makeFixture(dir: string, config: object = { dims: 8 }): Promise<Fixture> {
  const native = `bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`;
  const packages: Record<string, Record<string, string>> = {
    "@huggingface/transformers": { "dist/transformers.node.mjs": FAKE_TRANSFORMERS },
    "onnxruntime-node": { [native]: "native", "bin/napi-v6/plan9/mips/other.node": "foreign" },
    "onnxruntime-common": { "index.js": "" },
  };
  const served = new Map<string, Buffer>();
  const runtime = [];
  for (const [name, files] of Object.entries(packages)) {
    const manifest = JSON.stringify({ name, version: "1.2.3" });
    const bytes = await tarball(dir, name, { "package.json": manifest, ...files });
    const base = name.slice(name.lastIndexOf("/") + 1);
    served.set(`https://registry.test/${name}/-/${base}-1.2.3.tgz`, bytes);
    runtime.push({ name, version: "1.2.3", integrity: ssri.fromData(bytes).toString() });
  }
  const model = { "config.json": JSON.stringify(config), "onnx/weights.bin": "w".repeat(4096) };
  const files = Object.entries(model).map(([path, text]) => {
    served.set(`https://models.test/rev/${path}`, Buffer.from(text));
    const sha256 = createHash("sha256").update(text).digest("hex");
    return { path, sha256, bytes: Buffer.byteLength(text) };
  });
  const requests: string[] = [];
  return {
    catalog: {
      registry: "https://registry.test",
      runtime,
      modelId: "fixture-model",
      embedModel: "fixture-model@test",
      dims: 8,
      pooling: "cls",
      dtype: "q8",
      modelSource: "https://models.test/rev/",
      files,
    },
    requests,
    served,
    fetch: (url) => {
      requests.push(url);
      const bytes = served.get(url);
      return Promise.resolve(
        bytes === undefined
          ? new Response("not found", { status: 404 })
          : new Response(new Uint8Array(bytes)),
      );
    },
  };
}
