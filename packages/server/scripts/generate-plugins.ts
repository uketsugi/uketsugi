/**
 * Writes the one file of a plugin that says what the server's code says: the rule Antigravity's
 * plugin carries, which is the block. `pnpm generate` writes it; a test fails when the file and
 * the block disagree.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BLOCK_TEXT } from "@uketsugi/contracts";

const RULE_URL = new URL("../plugins/antigravity/rules/AGENTS.md", import.meta.url);

/** The rule as the block generates it now, and the path it belongs at. */
export function generatedRule(): { path: string; text: string } {
  return { path: fileURLToPath(RULE_URL), text: BLOCK_TEXT };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { path, text } = generatedRule();
  writeFileSync(path, text);
}
