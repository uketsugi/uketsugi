/**
 * Verification of a model directory against the catalog, by reading the files themselves: each
 * runtime package is present at its pinned version with this platform's native binding, and every
 * model file has its pinned size and SHA-256. Nothing is trusted from a record of a past install.
 */
import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import ssri from "ssri";
import { CATALOG, layout, unsupportedPlatform, type Catalog } from "./catalog.ts";
import { isMissing } from "./faults.ts";

/** Why a model directory cannot be used. `changed` is a file or version that differs from its pin. */
export type ModelFault = "unsupported_platform" | "not_installed" | "changed";

export type ModelCheck =
  | { readonly ok: true; readonly model: string }
  | { readonly ok: false; readonly reason: ModelFault; readonly detail: string };

const fault = (reason: ModelFault, detail: string): ModelCheck => ({ ok: false, reason, detail });

/** The version a package directory declares, or null when it holds no package. */
async function installedVersion(dir: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as unknown;
    const version = (manifest as { version?: unknown } | null)?.version;
    return typeof version === "string" ? version : null;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function runtimeFault(root: string, catalog: Catalog): Promise<ModelCheck | null> {
  const at = layout(root, catalog);
  for (const pin of catalog.runtime) {
    const version = await installedVersion(at.packageDir(pin.name));
    if (version === null) return fault("not_installed", `${pin.name} is not in ${at.packages}`);
    if (version !== pin.version)
      return fault("changed", `${pin.name} is ${version}; the pinned version is ${pin.version}`);
  }
  const binding = join(at.binding(process.platform, process.arch), "onnxruntime_binding.node");
  if (!(await exists(binding))) return fault("not_installed", `${binding} is missing`);
  if (!(await exists(at.entry))) return fault("not_installed", `${at.entry} is missing`);
  if ((await installedVersion(at.packageDir("sharp"))) === null)
    return fault("not_installed", `the sharp stub is not in ${at.packages}`);
  return null;
}

/**
 * Whether a file's bytes match a subresource-integrity value and, when one is given, a size. A
 * missing file rejects with ENOENT.
 */
export async function fileMatches(
  path: string,
  integrity: string | ssri.IntegrityLike,
  size?: number,
): Promise<boolean> {
  try {
    await ssri.checkStream(createReadStream(path), integrity, size === undefined ? {} : { size });
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EINTEGRITY" || code === "EBADSIZE") return false;
    throw error;
  }
}

async function modelFault(root: string, catalog: Catalog): Promise<ModelCheck | null> {
  const dir = layout(root, catalog).model;
  for (const file of catalog.files) {
    const path = join(dir, file.path);
    try {
      if (!(await fileMatches(path, ssri.fromHex(file.sha256, "sha256"), file.bytes)))
        return fault("changed", `${path} does not have its pinned SHA-256 ${file.sha256}`);
    } catch (error) {
      if (isMissing(error)) return fault("not_installed", `${path} is missing`);
      throw error;
    }
  }
  return null;
}

/**
 * Whether `root` holds the catalog's runtime and model, intact, for this machine. It reads every
 * model file once (about 55 MB), so it costs tens of milliseconds, not seconds.
 */
export async function verifyModel(root: string, catalog: Catalog = CATALOG): Promise<ModelCheck> {
  const unsupported = unsupportedPlatform();
  if (unsupported !== null)
    return fault("unsupported_platform", `the embedding runtime has no build for ${unsupported}`);
  return (
    (await runtimeFault(root, catalog)) ??
    (await modelFault(root, catalog)) ?? { ok: true, model: catalog.embedModel }
  );
}
