/** `--product none`: a case with no server, nothing installed and no deliveries, running the same session rows. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { adapterFor } from "../../src/recall/adapters.ts";
import type { AdapterContext } from "../../src/recall/adapter.ts";
import { Case } from "../../src/recall/case.ts";
import { SERVER_PORT } from "../../src/recall/environment.ts";
import { Workspace } from "../../src/recall/workspace.ts";

let root = "";
let workspace: Workspace;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "recall-check-none-"));
  process.env["TMPDIR"] = root;
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "stand-in-token-for-checks";
  workspace = await Workspace.create();
});

afterAll(async () => {
  await workspace.close();
  rmSync(root, { recursive: true, force: true });
});

test("a case of the none product serves nothing, installs nothing and delivers nothing, and still runs a session", async () => {
  const claude = join(root, "claude");
  writeFileSync(claude, `#!/bin/sh\necho '{"type":"result","is_error":false,"result":"ok"}'\n`);
  chmodSync(claude, 0o755);
  const tools = { goroot: "", pythonBase: "", claude };
  const adapter = adapterFor("none");
  const c = await Case.open({
    adapter,
    context: { workspace, tools } as unknown as AdapterContext,
    tools,
    config: adapter.configurations[0],
    name: "none",
    seeded: false,
  });
  try {
    expect(c.serving.port).toBe(0);
    expect(existsSync(join(c.environment.socks, `${SERVER_PORT}.sock`))).toBe(false);
    expect(c.installed).toEqual([]);
    expect(readdirSync(c.home)).toEqual([]);
    expect(adapter.session(adapter.configurations[0])).toEqual({ allowedTools: "" });
    const tree = join(root, "tree");
    mkdirSync(tree);
    const result = await c.session({ name: "s", tree, prompt: "hi" });
    expect(result.end.kind).toBe("done");
    expect(adapter.deliveries(result.transcript)).toEqual([]);
    expect(await c.readStore()).toEqual([]);
  } finally {
    await c.close();
  }
}, 60_000);
