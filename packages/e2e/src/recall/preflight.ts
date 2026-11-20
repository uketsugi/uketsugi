/**
 * Finds what a run needs on this machine and says, for each piece that is missing, the line that fixes
 * it. Nothing here starts a session or touches the network.
 */
import { realpath, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolveTool, run } from "./process.ts";

export interface Tools {
  /** `go env GOROOT`. */
  readonly goroot: string;
  /** Python's user base, where pytest and PyYAML are installed for this person. */
  readonly pythonBase: string;
  /** The harness program's real path, when sessions are needed. */
  readonly claude?: string;
}

const PROGRAMS: Record<string, string> = {
  bwrap: "install bubblewrap (apt install bubblewrap)",
  git: "install git",
  go: "install Go, the version ergo's go.mod names (the suite sets GOTOOLCHAIN=local)",
  python3: "install Python 3 with pytest and PyYAML (pip install --user pytest pyyaml)",
  setpriv: "install util-linux, which provides setpriv",
  sh: "install a POSIX shell",
  curl: "install curl, which the plugin's hook script calls",
};

const MIN_FREE_GB = 10;

export async function preflight(options: { sessions: boolean }): Promise<Tools> {
  const missing: string[] = [];
  for (const [name, fix] of Object.entries(PROGRAMS)) {
    if (resolveTool(name) === undefined) missing.push(`${name} is not on PATH: ${fix}`);
  }
  let claude: string | undefined;
  if (options.sessions) {
    const found = resolveTool("claude");
    if (found === undefined) missing.push("claude is not on PATH: install Claude Code");
    else claude = await realpath(found);
  }
  if (missing.length > 0) throw new Error(`this machine is not ready:\n  ${missing.join("\n  ")}`);
  const python = await run(
    "python3",
    ["-c", "import site, pytest, yaml; print(site.getuserbase())"],
    {
      allowFailure: true,
    },
  );
  if (python.code !== 0) {
    throw new Error("python3 cannot import pytest and yaml: pip install --user pytest pyyaml");
  }
  const goroot = (await run("go", ["env", "GOROOT"])).stdout.trim();
  const free = await statfs(tmpdir());
  if ((free.bavail * free.bsize) / 1e9 < MIN_FREE_GB) {
    throw new Error(
      `${tmpdir()} has under ${MIN_FREE_GB} GB free: set TMPDIR to a folder on a larger disk`,
    );
  }
  return { goroot, pythonBase: python.stdout.trim(), ...(claude === undefined ? {} : { claude }) };
}
