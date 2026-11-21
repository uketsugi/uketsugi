/** The harness-memory check, with a stand-in `claude` that keeps a note in its own memory (or does not read it). */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AdapterContext } from "../../src/recall/adapter.ts";
import { Workspace } from "../../src/recall/workspace.ts";
import { readingFromRun } from "../../src/recall/quota.ts";
import { memcheck } from "../../src/live/memcheck.ts";

let root = "";
let workspace: Workspace;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "recall-check-memcheck-"));
  process.env["TMPDIR"] = root;
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "stand-in-token-for-checks";
  workspace = await Workspace.create();
});
afterAll(async () => {
  await workspace.close();
  rmSync(root, { recursive: true, force: true });
});

/** A `claude` that writes the code word to its memory when told to keep it, and answers from that memory when `reads`. */
function standIn(name: string, reads: boolean): string {
  const path = join(root, name);
  writeFileSync(
    path,
    `#!/bin/sh
M="$HOME/.claude/projects/p/memory"
case "$2" in
  *"keep this"*) mkdir -p "$M"; echo "code word quince-47" > "$M/note.md"; echo '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","utilization":0.8,"resetsAt":99999999999,"isUsingOverage":false}}'; echo '{"type":"result","result":"noted"}';;
  *) if [ "${reads}" = true ] && [ -f "$M/note.md" ]; then echo "{\\"type\\":\\"result\\",\\"result\\":\\"$(cat $M/note.md)\\"}"; else echo '{"type":"result","result":"I do not know"}'; fi;;
esac
`,
  );
  chmodSync(path, 0o755);
  return path;
}

async function checked(claude: string) {
  const tools = { goroot: "", pythonBase: "", claude };
  const out = join(root, `out-${claude.split("/").at(-1)}`);
  mkdirSync(out);
  const context = { workspace, tools, model: "haiku" } as unknown as AdapterContext;
  return memcheck({ context, tools, out });
}

describe("the harness-memory check", () => {
  test("passes when the later session answers from the memory the first one wrote, and says what was written and carried", async () => {
    const result = await checked(standIn("reads", true));
    expect(result.passed).toBe(true);
    expect(result.wrote.some((f) => f.endsWith("note.md"))).toBe(true);
    expect(result.carried).toEqual(result.wrote);
    expect(result.answer).toContain("quince-47");
  }, 120_000);

  test("keeps its transcripts where the next run reads the window from", async () => {
    await checked(standIn("keeps", true));
    expect(await readingFromRun(join(root, "out-keeps"))).toEqual({ utilization: 0.8, ok: true });
  }, 120_000);

  test("fails when the later session does not know it", async () => {
    const result = await checked(standIn("ignores", false));
    expect(result.passed).toBe(false);
    expect(result.answer).toContain("I do not know");
  }, 120_000);
});
