import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The version this `ukt` is. A release says it in its own `VERSION` file, beside the launcher it
 * was started by: the version alone for a build from that version's tag, and `+<commit>` after it
 * for any other build, so that a candidate is not taken for the release. Run from source, the
 * package's version.
 */
export function version(env: NodeJS.ProcessEnv = process.env): string {
  const launcher = env["UKT_LAUNCHER"];
  if (launcher !== undefined && launcher !== "") {
    try {
      const first = readFileSync(join(dirname(launcher), "..", "VERSION"), "utf8").split("\n")[0];
      const said = /^uketsugi (\S+)$/.exec(first ?? "")?.[1];
      if (said !== undefined) return said;
    } catch {
      // A launcher with no VERSION beside it is not a release folder: the package's own version stands.
    }
  }
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return manifest.version;
}
