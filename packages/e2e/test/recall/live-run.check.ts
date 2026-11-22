/**
 * A unit end to end on the real host, with stand-ins for what needs the network and the model: a git
 * repository for ergo's trees, a `claude` that edits the tree and writes a harness memory file, a
 * product that serves a store. It shows the wiring that only a live run would otherwise show: each
 * session in its own case, E's home and store and instruction files in L, the server stopped before
 * L, the evidence where `score.ts` reads it, and the run scored from it.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as http } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { Adapter, AdapterContext } from "../../src/recall/adapter.ts";
import { none } from "../../src/recall/none.ts";
import { Guard } from "../../src/recall/quota.ts";
import { Workspace } from "../../src/recall/workspace.ts";
import { LiveHost } from "../../src/live/host.ts";
import { runUnits } from "../../src/live/run.ts";
import { freeze } from "../../src/live/pool.ts";
import type { ChainData, Rebuilt } from "../../src/recall/chain.ts";
import { ITEMS, SCORING } from "./live-world.ts";
import { installCommands } from "../../src/recall/uketsugi.ts";
import { armsOf } from "../../src/live/start.ts";

let root = "";
let workspace: Workspace;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "recall-check-live-run-"));
  process.env["TMPDIR"] = root;
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "stand-in-token-for-checks";
  workspace = await Workspace.create();
});
afterAll(async () => {
  await workspace.close();
  rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=n", ...args], { cwd })
    .toString()
    .trim();

/** A mirror with one commit per task parent. */
function mirrorOf(tasks: string[], tag = ""): Rebuilt {
  const mirror = join(root, `mirror${tag}`);
  mkdirSync(mirror);
  git(mirror, "init", "-q");
  const parent: Record<string, string> = {};
  tasks.forEach((task, n) => {
    writeFileSync(join(mirror, "code.txt"), `reference ${n}`);
    git(mirror, "add", "-A");
    git(mirror, "commit", "-q", "-m", `before ${task}`);
    parent[task] = git(mirror, "rev-parse", "HEAD");
  });
  return { mirror, parent, squash: {} };
}

const taskOf = (task: string) => ({
  prompt: `do ${task}`,
  tests: [],
  testCmd: ["sh", "-c", `test -f fixed && echo "PASSED t::D1"`],
});

/** What a store of the stand-in product holds: one fact that matches item D1's pattern. */
let stopped = 0;
let outDir = "";
const manifestAtServe: boolean[] = [];
const product: Adapter = {
  name: "stand-in",
  memory: { call: ["^mcp__uketsugi__"], touch: ["uketsugi"] },
  boilerplate: [],
  configurations: ["setup"],
  session: () => ({ allowedTools: "" }),
  async serve(_context, _config, dir) {
    manifestAtServe.push(existsSync(join(outDir, "manifest.json")));
    mkdirSync(join(dir, "data"), { recursive: true });
    const server = http((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    return {
      port,
      url: `http://127.0.0.1:${port}`,
      stop: () => new Promise<void>((resolve) => server.close(() => ((stopped += 1), resolve()))),
      exit: () => null,
    };
  },
  seed: () => Promise.resolve(0),
  install: () => Promise.resolve([]),
  afterSession: () => Promise.resolve(),
  readStore: () => Promise.resolve([{ id: "f1", claim: "marker-D1 is what the person told us" }]),
  deliveries: () => [],
};

interface Executed {
  readonly out: string;
  readonly text: string;
  readonly work: string;
}

/** Runs one unit on the real host; `extraClaude` is shell the stand-in `claude` runs first. */
async function execute(
  tag: string,
  extraClaude = "",
  freezeFirst = true,
  armsFor: Record<"memory" | "none", { adapter: Adapter; config: string }> = {
    memory: { adapter: product, config: "setup" },
    none: { adapter: none, config: "none" },
  },
): Promise<Executed> {
  const rebuilt = mirrorOf(["T1", "T2", "T4", "T8"], tag);
  const chain = {
    name: "stand-in",
    repo: { origin: "https://github.com/ergochat/ergo.git", base: "x" },
    env: {},
    followup: "again",
    maxFollowups: 1,
    exclude: [],
    helper: { name: "mail", script: "benchtests/mailrelay.py", port: 2525 },
    tasks: Object.fromEntries(["T1", "T2", "T4", "T8"].map((t) => [t, taskOf(t)])),
  } as unknown as ChainData;
  const claude = join(root, `claude${tag}`);
  writeFileSync(
    claude,
    `#!/bin/sh
case "$2" in
  *T1*|*T2*) mkdir -p "$HOME/.claude/projects/p/memory"; echo remembered > "$HOME/.claude/projects/p/memory/note.md"; echo rules > CLAUDE.md;;
esac
touch fixed
${extraClaude}echo '{"type":"result","is_error":false,"result":"ok"}'
`,
  );
  chmodSync(claude, 0o755);
  const python = join(root, "python");
  mkdirSync(join(python, "lib"), { recursive: true });
  const tools = { goroot: "", pythonBase: python, claude };
  const context = {
    workspace,
    tools,
    model: "haiku",
    harnessMemory: true,
  } as unknown as AdapterContext;
  const out = join(root, `out${tag}`);
  mkdirSync(out);
  outDir = out;
  const host = new LiveHost({
    chain,
    rebuilt,
    judge: { chain, tools, workspace: workspace.path, hide: [workspace.path] },
    context,
    tools,
    items: ITEMS,
    arms: armsFor,
    out,
    startedAt: Date.now(),
  });

  if (freezeFirst)
    await freeze(out, { folders: [], config: "setup", model: "haiku", harness: "2.1.0" });
  const text = await runUnits(host, {
    units: 1,
    guard: new Guard({ utilization: 0.5, ok: true }),
    work: join(root, `work${tag}`),
    out,
    build: "stand-in",
    config: "setup",
    model: "haiku",
    hash: "h",
    pool: [],
    scoring: SCORING,
    harness: () => "2.1.0",
  });
  return { out, text, work: join(root, `work${tag}`) };
}

test("a unit runs in both arms on the real host and is scored from the evidence it kept", async () => {
  const { out, text } = await execute("");
  const run = JSON.parse(readFileSync(join(out, "run.json"), "utf8")) as {
    units: {
      void: boolean;
      arms: Record<
        string,
        {
          earlier: { end: unknown };
          later: Record<string, { end: unknown }>;
          carried: { memory: string[]; instructions: string[] };
        }
      >;
    }[];
  };
  const unit = run.units[0];
  expect(unit?.void).toBe(false);
  for (const arm of ["memory", "none"]) {
    expect(unit?.arms[arm]?.earlier.end).toEqual({ kind: "done" });
    expect(unit?.arms[arm]?.later["T4"]?.end).toEqual({ kind: "done" });
    expect(unit?.arms[arm]?.carried.instructions).toContain("CLAUDE.md");
    expect(unit?.arms[arm]?.carried.memory.some((f) => f.endsWith("note.md"))).toBe(true);
    for (const role of ["E", "T4", "T8"])
      expect(existsSync(join(out, "cases", `u1-${arm}-${role}`, "steps.jsonl"))).toBe(true);
  }
  // E's home and store reached L: the harness memory file is in the later session's home, its tree holds E's CLAUDE.md.
  expect(
    readFileSync(
      join(
        root,
        "work",
        "u1",
        "memory",
        "T4",
        "home",
        ".claude",
        "projects",
        "p",
        "memory",
        "note.md",
      ),
      "utf8",
    ),
  ).toContain("remembered");
  expect(
    readFileSync(join(root, "work", "u1", "memory", "T4", "tree", "CLAUDE.md"), "utf8"),
  ).toContain("rules");
  expect(existsSync(join(root, "work", "u1", "none", "T8", "tree", "fixed"))).toBe(true);
  // the judge's file for L is where the scorer reads it, and the store E left is the one scored
  expect(
    JSON.parse(readFileSync(join(out, "cases", "u1-memory-T4", "judge", "L.T4.0.json"), "utf8")),
  ).toMatchObject({ passed: true });
  expect(text.split("\n")[0]).toContain(
    "live-hour stand-in setup haiku · 1 units, 0 void, 0 capped",
  );
  expect(text).toContain("D1  passing,  stored 1/1");
  expect(stopped).toBeGreaterThanOrEqual(3);
}, 240_000);

test("the manifest is written, with its hash, before the first session starts, and a run without one is refused", async () => {
  manifestAtServe.length = 0;
  const done = await execute("-m");
  expect(manifestAtServe.length).toBeGreaterThan(0);
  expect(manifestAtServe.every(Boolean)).toBe(true);
  expect(
    (JSON.parse(readFileSync(join(done.out, "manifest.json"), "utf8")) as { hash: string }).hash,
  ).toMatch(/^[0-9a-f]{16}$/);
  await expect(execute("-n", "", false)).rejects.toThrow(/manifest is not frozen/);
}, 240_000);

test("a no-memory session that only touches a path holding the product's name is not a call to the memory server", async () => {
  const call = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "b1", name: "Bash", input: { command: "ls /srv/uketsugi" } },
      ],
    },
  });
  const done = await execute("-p", `echo '${call}'\n`);
  expect(done.text.split("\n")[0]).not.toContain("called the memory server");
}, 240_000);

test("a no-memory session that calls the memory server voids the run, loudly", async () => {
  const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const call = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "m1", name: "mcp__uketsugi__search_facts", input: {} }],
      },
    });
    const done = await execute("-l", `echo '${call}'\n`);
    expect(done.text.split("\n")[0]).toMatch(
      /^VOID \(a no-memory session called the memory server/,
    );
    expect(said).toHaveBeenCalledWith(
      expect.stringContaining(
        "RUN VOID: the no-memory session u1-none-E called mcp__uketsugi__search_facts",
      ),
    );
  } finally {
    said.mockRestore();
  }
}, 240_000);

test("the arms the command builds: the no-memory arm has no server, no MCP configuration and no instruction text; the memory arm has all three", async () => {
  const arms = armsOf("setup");
  const [memory, nothing] = [arms.memory.adapter, arms.none.adapter];
  expect(nothing.name).toBe("none");
  expect(memory.name).toBe("uketsugi");
  expect(arms.none.config).toBe("none");
  expect((await nothing.serve({} as never, "none", root, 0)).port).toBe(0);
  expect(await nothing.install({} as never, {} as never, {} as never, "none", root)).toEqual([]);
  expect(nothing.boilerplate).toEqual([]);
  expect(nothing.memory.call).toEqual([]);
  expect(nothing.session("none")).toEqual({ allowedTools: "" });
  expect(memory.boilerplate.length).toBeGreaterThan(0);
  expect(memory.session("setup").allowedTools).toContain("mcp__uketsugi");
  expect(installCommands("setup").some((c) => c.join(" ").includes("mcp add"))).toBe(true);
});
