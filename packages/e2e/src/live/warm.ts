/**
 * One Go build cache, warmed once by building ergo's code in the sandbox, and copied into each
 * case's home (`host.ts`), so that no session pays for the standard library and the vendored
 * modules again. The cache is a folder of the workspace; what is built is T1's reference tree.
 */
import { mkdir } from "node:fs/promises";
import type { Prepared } from "../recall/prepare.ts";
import type { Tools } from "../recall/preflight.ts";
import { run } from "../recall/process.ts";
import { makeTree } from "../recall/chain.ts";
import { sandboxCommand, stageSockets, type Bind } from "../recall/sandbox.ts";
import type { Workspace } from "../recall/workspace.ts";

/** Builds the tree and returns the folder that holds `go-build`. */
export async function warmGoCache(
  prepared: Prepared,
  tools: Tools,
  workspace: Workspace,
): Promise<string> {
  const [cache, home, socks] = ["cache", "home", "socks"].map((n) => workspace.at("warm", n));
  const tree = workspace.at("warm", "tree");
  for (const dir of [cache, home, socks] as string[]) await mkdir(dir, { recursive: true });
  await stageSockets(socks as string);
  await makeTree(prepared.chain, prepared.rebuilt, prepared.rebuilt.parent["T1"] as string, tree);
  const readOnly: Bind[] = tools.goroot.startsWith("/home/")
    ? [{ from: tools.goroot, to: tools.goroot }]
    : [];
  const sandbox = await sandboxCommand({
    home: home as string,
    tree,
    socks: socks as string,
    ports: [],
    hide: [workspace.path],
    readOnly,
    writable: [{ from: cache as string, to: "/home/demo/cache" }],
    env: {
      ...prepared.chain.env,
      GOCACHE: "/home/demo/cache/go-build",
      GOPATH: "/home/demo/go",
      TMPDIR: "/home/demo",
    },
    cmd: [`${tools.goroot}/bin/go`, "build", "./..."],
  });
  await run(sandbox.command, sandbox.args, { env: sandbox.env });
  return cache as string;
}
