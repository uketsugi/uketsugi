/**
 * The judge: a task's hidden tests laid over a copy of a tree and run there, in the sandbox, because
 * the tree holds code an agent wrote. The judge never touches the tree itself. A task passes when its
 * test command exits 0. Toolchains that live under /home (Go, the Python packages) are bound in
 * read-only; the build caches are one writable folder of the workspace, warm after the first run.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./process.ts";
import { overlayTests, type ChainData } from "./chain.ts";
import { sandboxCommand, stageSockets, type Bind } from "./sandbox.ts";
import { removeTree } from "./workspace.ts";
import type { Tools } from "./preflight.ts";

export interface Judgement {
  readonly task: string;
  readonly passed: boolean;
  readonly code: number | null;
  readonly tail: string;
  /** Each test's outcome by node id (passed, failed, error, skipped ...), read from pytest's `-rA` summary. */
  readonly tests: Readonly<Record<string, string>>;
}

const OUTCOME = /^(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS) (\S.*?)(?: - .*)?$/;

export function outcomes(output: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const m = OUTCOME.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) found[m[2]] = m[1].toLowerCase();
  }
  return found;
}

export interface JudgeContext {
  readonly chain: ChainData;
  readonly tools: Tools;
  /** The workspace folder and everything else the sandbox must not show. */
  readonly workspace: string;
  readonly hide: readonly string[];
}

const TIMEOUT_MS = 900_000;

export async function judge(context: JudgeContext, task: string, tree: string): Promise<Judgement> {
  const { chain, tools, workspace } = context;
  const work = await mkdtemp(join(workspace, "judge-"));
  const [copy, home, socks] = [join(work, "tree"), join(work, "home"), join(work, "socks")];
  const cache = join(workspace, "judge-cache");
  for (const dir of [home, socks, cache]) await mkdir(dir, { recursive: true });
  await run("cp", ["-a", "--reflink=auto", tree, copy]); // fs.cp is minutes slower on a vendored tree
  const spec = chain.tasks[task];
  if (spec === undefined) throw new Error(`no task ${task}`);
  await overlayTests(spec, task, copy);
  await stageSockets(socks);
  const readOnly: Bind[] = [{ from: `${tools.pythonBase}/lib`, to: `${tools.pythonBase}/lib` }];
  if (tools.goroot.startsWith("/home/")) readOnly.push({ from: tools.goroot, to: tools.goroot });
  const sandbox = await sandboxCommand({
    home: home,
    tree: copy,
    socks: socks,
    ports: [],
    hide: context.hide,
    readOnly,
    writable: [{ from: cache, to: "/home/demo/cache" }],
    env: {
      ...chain.env,
      GOCACHE: "/home/demo/cache/go-build",
      GOPATH: "/home/demo/go",
      XDG_CACHE_HOME: "/home/demo/xdg",
      PYTHONUSERBASE: tools.pythonBase,
      PYTHONDONTWRITEBYTECODE: "1",
      TMPDIR: "/home/demo",
    },
    cmd: spec.testCmd.includes("pytest") ? [...spec.testCmd, "-rA"] : spec.testCmd,
  });
  const finished = await run(sandbox.command, sandbox.args, {
    env: sandbox.env,
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
    allowFailure: true,
  });
  await removeTree(work);
  return {
    task,
    passed: finished.code === 0,
    code: finished.code,
    tail: (finished.stdout + finished.stderr).slice(-1500),
    tests: outcomes(finished.stdout),
  };
}
