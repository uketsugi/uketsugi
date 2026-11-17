/**
 * The install of the pinned runtime and model into a model directory. No package manager runs and
 * no package script runs: each runtime tarball is fetched from the registry, checked against its
 * pinned integrity and only then unpacked; each model file is fetched at the pinned revision and
 * checked against its pinned size and SHA-256. Everything is built in a staging directory and
 * moved into place last, so a failed install leaves what was there before.
 */
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import ssri from "ssri";
import { extract } from "tar";
import { CATALOG, layout, tarballUrl, unsupportedPlatform, type Catalog } from "./catalog.ts";
import { describe } from "./faults.ts";
import { fileMatches, verifyModel } from "./verify.ts";

export type InstallFault = "unsupported_platform" | "fetch_failed" | "integrity_mismatch";

export type InstallOutcome =
  /** `fetched` is false when the directory already held the verified model and nothing was done. */
  | { readonly ok: true; readonly model: string; readonly fetched: boolean }
  | { readonly ok: false; readonly reason: InstallFault; readonly detail: string };

/** One download's progress. `total` is null when the server did not say. */
export interface InstallProgress {
  readonly name: string;
  readonly received: number;
  readonly total: number | null;
}

export interface InstallOptions {
  readonly catalog?: Catalog;
  /** How bytes are fetched. Defaults to the platform's `fetch`. */
  readonly fetch?: (url: string, init: { signal?: AbortSignal }) => Promise<Response>;
  readonly onProgress?: (progress: InstallProgress) => void;
  readonly signal?: AbortSignal;
}

class InstallFailure extends Error {
  readonly reason: InstallFault;
  constructor(reason: InstallFault, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

/** The stub that stands in for `sharp`: transformers.js imports it at load and calls it only for images. */
const SHARP_STUB = {
  "package.json": `${JSON.stringify({ name: "sharp", version: "0.0.0-stub", type: "module", main: "index.js" })}\n`,
  "index.js":
    'export default function sharp() { throw new Error("image input is not supported"); }\n',
};

interface Download {
  readonly name: string;
  readonly url: string;
  readonly to: string;
  readonly integrity: string | ssri.IntegrityLike;
  readonly bytes?: number;
}

/** Fetches one file to disk, then checks what was written: nothing unchecked is ever unpacked or kept. */
async function download(item: Download, options: InstallOptions): Promise<void> {
  const { signal, onProgress } = options;
  const init = signal === undefined ? {} : { signal };
  try {
    const response = await (options.fetch ?? fetch)(item.url, init);
    if (!response.ok || response.body === null)
      throw new Error(`the server answered ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? Number.NaN);
    const total = item.bytes ?? (Number.isFinite(length) ? length : null);
    let received = 0;
    const counted = async function* (chunks: AsyncIterable<Uint8Array>) {
      for await (const chunk of chunks) {
        received += chunk.length;
        onProgress?.({ name: item.name, received, total });
        yield chunk;
      }
    };
    await mkdir(dirname(item.to), { recursive: true });
    await pipeline(Readable.fromWeb(response.body), counted, createWriteStream(item.to), init);
  } catch (error) {
    throw new InstallFailure("fetch_failed", `${item.url}: ${describe(error)}`);
  }
  if (!(await fileMatches(item.to, item.integrity, item.bytes)))
    throw new InstallFailure(
      "integrity_mismatch",
      `${item.url} does not match its pinned checksum; nothing of it was kept`,
    );
}

/** Keeps a package's files except the native binaries of other platforms (`bin/napi-v6/<platform>/<arch>/`). */
function forThisPlatform(path: string): boolean {
  const [, top, , platform, arch] = path.split("/");
  if (top !== "bin" || platform === undefined || arch === undefined) return true;
  return platform === process.platform && arch === process.arch;
}

/** Builds `node_modules/` and `models/<id>/` under `staging` from checked downloads. */
async function stage(staging: string, catalog: Catalog, options: InstallOptions): Promise<void> {
  const at = layout(staging, catalog);
  for (const artifact of catalog.runtime) {
    const name = `${artifact.name}@${artifact.version}`;
    const tarball = join(staging, "downloads", `${randomBytes(4).toString("hex")}.tgz`);
    const { integrity } = artifact;
    await download({ name, url: tarballUrl(catalog, artifact), to: tarball, integrity }, options);
    const cwd = at.packageDir(artifact.name);
    await mkdir(cwd, { recursive: true });
    await extract({ file: tarball, cwd, strip: 1, filter: forThisPlatform });
  }
  await mkdir(at.packageDir("sharp"), { recursive: true });
  for (const [name, text] of Object.entries(SHARP_STUB))
    await writeFile(join(at.packageDir("sharp"), name), text);
  for (const file of catalog.files) {
    await download(
      {
        name: file.path,
        url: new URL(file.path, catalog.modelSource).href,
        to: join(at.model, file.path),
        integrity: ssri.fromHex(file.sha256, "sha256"),
        bytes: file.bytes,
      },
      options,
    );
  }
}

/** Replaces `to` with `from`, keeping the old tree until the new one is in place. */
async function swap(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  const old = `${to}.old-${randomBytes(4).toString("hex")}`;
  const existed = await rename(to, old).then(
    () => true,
    () => false,
  );
  await rename(from, to);
  if (existed) await rm(old, { recursive: true, force: true });
}

/**
 * Makes `root` hold the catalog's runtime and model. A directory that already verifies is left
 * alone; anything else is rebuilt whole. The outcome says which, or why the install was refused.
 */
export async function installModel(
  root: string,
  options: InstallOptions = {},
): Promise<InstallOutcome> {
  const catalog = options.catalog ?? CATALOG;
  const unsupported = unsupportedPlatform();
  if (unsupported !== null)
    return {
      ok: false,
      reason: "unsupported_platform",
      detail: `the embedding runtime has no build for ${unsupported}`,
    };
  if ((await verifyModel(root, catalog)).ok)
    return { ok: true, model: catalog.embedModel, fetched: false };

  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const name of await readdir(root))
    if (name.startsWith(".staging-")) await rm(join(root, name), { recursive: true, force: true });
  const staging = join(root, `.staging-${randomBytes(6).toString("hex")}`);
  try {
    await stage(staging, catalog, options);
    const [staged, placed] = [layout(staging, catalog), layout(root, catalog)];
    await swap(staged.packages, placed.packages);
    await swap(staged.model, placed.model);
    const check = await verifyModel(root, catalog);
    if (!check.ok) return { ok: false, reason: "integrity_mismatch", detail: check.detail };
    return { ok: true, model: catalog.embedModel, fetched: true };
  } catch (error) {
    if (error instanceof InstallFailure)
      return { ok: false, reason: error.reason, detail: error.message };
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
