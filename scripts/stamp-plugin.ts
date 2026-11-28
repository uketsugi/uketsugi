/**
 * Gives the Claude Code plugin of a built release its version, which `claude plugin list` shows
 * (without one it says "unknown"). The version has one source, `packages/cli/package.json`, and the
 * plugin's manifest in the tree does not state it: the release build runs this on its copy of the
 * plugins, with the label the release is built under (a candidate's carries `+<commit>`).
 *
 *   node scripts/stamp-plugin.ts <the release's plugins folder> <label>
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST = "claude-code/.claude-plugin/plugin.json";

/** The manifest's text with its version set to `label`. */
export function stamped(manifest: string, label: string): string {
  const parsed = JSON.parse(manifest) as Record<string, unknown>;
  return `${JSON.stringify({ ...parsed, version: label }, null, 2)}\n`;
}

if (process.argv[1] === import.meta.filename) {
  const [folder, label] = process.argv.slice(2);
  if (folder === undefined || label === undefined)
    throw new Error("usage: stamp-plugin <folder> <label>");
  const file = join(folder, MANIFEST);
  // Replaced, not written in place: the release's files may be links to the tree's own.
  writeFileSync(`${file}.new`, stamped(readFileSync(file, "utf8"), label));
  renameSync(`${file}.new`, file);
}
