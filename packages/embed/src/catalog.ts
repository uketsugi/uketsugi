/**
 * The pinned model and the pinned runtime that runs it. An install fetches exactly these and a
 * verification checks against them. The recorded vectors the search values were measured on came
 * from this pair; changing either pin changes every vector, so it means a new model id and a
 * re-embed.
 */
import { join } from "node:path";

/** One npm tarball of the runtime, as the registry serves it. */
export interface RuntimeArtifact {
  readonly name: string;
  readonly version: string;
  /** The tarball's subresource-integrity string (`sha512-…`), as the registry publishes it. */
  readonly integrity: string;
}

/** One file of the model, at `path` under the model's directory. */
export interface ModelFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Everything an install and a load need to know of the one model. */
export interface Catalog {
  /** The npm registry the runtime's tarballs come from, without a trailing slash. */
  readonly registry: string;
  readonly runtime: readonly RuntimeArtifact[];
  /** The directory name of the model under `models/`. */
  readonly modelId: string;
  /** The id stored beside every vector: the model, its precision and the start of its weights' hash. */
  readonly embedModel: string;
  readonly dims: number;
  /** How token vectors become one text vector: the first token's, or the mean of all. */
  readonly pooling: "cls" | "mean";
  /** The weight precision the runtime loads; `q8` reads `onnx/model_quantized.onnx`. */
  readonly dtype: string;
  /** Where the model's files are fetched from: this URL followed by a file's path. */
  readonly modelSource: string;
  readonly files: readonly ModelFile[];
}

/**
 * granite-embedding-small-english-r2 (IBM, Apache-2.0) in its int8 ONNX conversion, on
 * transformers.js 4.3.2 over onnxruntime-node 1.30.0.
 */
export const CATALOG: Catalog = {
  registry: "https://registry.npmjs.org",
  runtime: [
    {
      name: "@huggingface/transformers",
      version: "4.3.2",
      integrity:
        "sha512-V3+dqf3iWlRYJ9I9GreM3zGQd0lAXnnoPeddmkOQYWAEE4l/+Fi6p7tx/qVUJlKQgLXGim2W76rTOzz+eC0i7g==",
    },
    {
      name: "onnxruntime-node",
      version: "1.30.0",
      integrity:
        "sha512-twhs1C2C/BFkz1yc5OY0KIU2GUq6DURO7hD4bx5Q2Qy3nAMJwRXW8xU3NVczE29VA9lolLOYepoD8fjTGOfIqw==",
    },
    {
      name: "onnxruntime-common",
      version: "1.30.0",
      integrity:
        "sha512-7fdVWjAID1dVhH/G8qK3APARunV4VkBFoCQAP7qp4Wkab0mrorvmc+sqiT+mKXOzDqdjN5j+/Z9nb4gzNPWcyA==",
    },
  ],
  modelId: "granite-small-r2",
  embedModel: "granite-small-r2@int8:1f4cf47e4ade",
  dims: 384,
  pooling: "cls",
  dtype: "q8",
  modelSource:
    "https://huggingface.co/onnx-community/granite-embedding-small-english-r2-ONNX/resolve/1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8/",
  files: [
    {
      path: "config.json",
      sha256: "1a1710c20911da8c96179716bf44058e54cca6fa7952cce77be83ef05edae3ee",
      bytes: 1526,
    },
    {
      path: "tokenizer.json",
      sha256: "feeb83348dcb033bc6b9d2e1f7906ca9eb2d122845000c9416d894d7c2927149",
      bytes: 2128614,
    },
    {
      path: "tokenizer_config.json",
      sha256: "ce06781b38bb393db68c9e0709bddd31ef5d88f2c6fbb3fd9f369778fb85e451",
      bytes: 20839,
    },
    {
      path: "special_tokens_map.json",
      sha256: "ea97ecdbcc73713039d8d64dbb05e3689495c96657fbd9a18f5bed381be81049",
      bytes: 694,
    },
    {
      path: "onnx/model_quantized.onnx",
      sha256: "a3fad524afc3f060216a8ddbb1ac89c9b6498fba8995b5718bde879076a2e9ba",
      bytes: 598902,
    },
    {
      path: "onnx/model_quantized.onnx_data",
      sha256: "1f4cf47e4adec7f7ae09db03d071ba8667e07f9a4203142c7efa8d37fe453597",
      bytes: 51885568,
    },
  ],
};

/**
 * The layout of a model directory, the one `ukt setup` makes and `UKT_MODEL_DIR` may point at:
 * `node_modules/` holds the runtime's packages and `models/<id>/` the model's files.
 */
export function layout(root: string, catalog: Catalog) {
  const packages = join(root, "node_modules");
  return {
    packages,
    packageDir: (name: string) => join(packages, ...name.split("/")),
    /** What a loader imports: transformers.js's build for Node. */
    entry: join(packages, "@huggingface", "transformers", "dist", "transformers.node.mjs"),
    /** The native binding of this platform, inside onnxruntime-node. */
    binding: (platform: string, arch: string) =>
      join(packages, "onnxruntime-node", "bin", "napi-v6", platform, arch),
    models: join(root, "models"),
    model: join(root, "models", catalog.modelId),
  };
}

/** Where the registry serves an artifact's tarball. */
export function tarballUrl(catalog: Catalog, artifact: RuntimeArtifact): string {
  const base = artifact.name.slice(artifact.name.lastIndexOf("/") + 1);
  return `${catalog.registry}/${artifact.name}/-/${base}-${artifact.version}.tgz`;
}

/**
 * Why this machine cannot run the runtime, or null when it can. onnxruntime-node 1.30.0 ships
 * binaries for Linux on glibc (x64, arm64), macOS on arm64 and Windows (x64, arm64).
 */
export function unsupportedPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
  glibc: boolean = hasGlibc(),
): string | null {
  const archs: Record<string, readonly string[]> = {
    linux: ["x64", "arm64"],
    darwin: ["arm64"],
    win32: ["x64", "arm64"],
  };
  if (!(archs[platform] ?? []).includes(arch)) return `${platform}-${arch}`;
  return platform === "linux" && !glibc ? `linux-${arch} without glibc` : null;
}

function hasGlibc(): boolean {
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  return report.header?.glibcVersionRuntime !== undefined;
}
