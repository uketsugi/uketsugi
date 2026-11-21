/**
 * The ergo chain: twelve reference commits R1..R12 made from `data/ergo-chain/reference/*.patch` onto
 * ergo's pinned commit, and for each task a commit with that task's hidden tests laid over R<n>.
 * `rebuildChain` proves the rebuild is the chain by comparing all 24 trees with `trees.json`.
 * `makeTree` gives a session a clone whose history ends at one commit, so that nothing later is in it.
 */
import { appendFile, cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./process.ts";

export const DATA = fileURLToPath(new URL("../../data/ergo-chain", import.meta.url));

export interface Task {
  readonly prompt: string;
  readonly tests: readonly string[];
  readonly testCmd: readonly string[];
  /** Words said to the agent after this task passes. */
  readonly sayAfterTask?: string;
}

export interface ChainData {
  readonly name: string;
  readonly repo: { readonly origin: string; readonly base: string };
  readonly env: Readonly<Record<string, string>>;
  readonly followup: string;
  readonly maxFollowups: number;
  /** Build outputs that are not an agent's edit of the source. */
  readonly exclude: readonly string[];
  readonly helper: { readonly name: string; readonly script: string; readonly port: number };
  readonly tasks: Readonly<Record<string, Task>>;
}

/** The commits of a rebuilt mirror: each task's parent (the reference before it) and its hidden-test commit. */
export interface Rebuilt {
  readonly mirror: string;
  readonly parent: Readonly<Record<string, string>>;
  readonly squash: Readonly<Record<string, string>>;
}

const AUTHOR = {
  GIT_AUTHOR_NAME: "bench",
  GIT_AUTHOR_EMAIL: "bench@example.invalid",
  GIT_COMMITTER_NAME: "bench",
  GIT_COMMITTER_EMAIL: "bench@example.invalid",
};

export async function loadChain(): Promise<ChainData> {
  return JSON.parse(await readFile(join(DATA, "chain.json"), "utf8")) as ChainData;
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const finished = await run("git", args, { cwd, env: { ...process.env, ...AUTHOR } });
  return finished.stdout.trim();
}

/** Copies the task's hidden-test files over `dest`; whatever stands there is replaced, not written through. */
export async function overlayTests(task: Task, name: string, dest: string): Promise<void> {
  for (const path of task.tests) {
    const target = join(dest, path);
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { force: true });
    await cp(join(DATA, "hidden", path), target);
  }
}

/**
 * Clones ergo (a URL or a local path) into `mirror` and rebuilds the chain there. Throws unless all 24
 * trees equal `trees.json`; returns what the cases need to clone from.
 */
export async function rebuildChain(
  chain: ChainData,
  ergo: string,
  mirror: string,
): Promise<Rebuilt> {
  await run("git", ["clone", "-q", "--no-checkout", "--no-hardlinks", ergo, mirror]);
  const base = await git(mirror, "rev-parse", `${chain.repo.base}^{commit}`);
  await git(mirror, "checkout", "-q", "-b", "ref", base);
  const patches = (await readdir(join(DATA, "reference")))
    .filter((f) => f.endsWith(".patch"))
    .sort();
  const trees: Record<string, string> = {};
  const parent: Record<string, string> = {};
  const refs: string[] = [];
  let before = base;
  for (const [index, patch] of patches.entries()) {
    const n = index + 1;
    await git(
      mirror,
      "am",
      "-q",
      "--committer-date-is-author-date",
      join(DATA, "reference", patch),
    );
    refs.push(await git(mirror, "rev-parse", "HEAD"));
    trees[`R${n}`] = await git(mirror, "rev-parse", "HEAD^{tree}");
    parent[`T${n}`] = before;
    before = refs[index] ?? before;
  }
  const squash: Record<string, string> = {};
  for (const [index, ref] of refs.entries()) {
    const name = `T${index + 1}`;
    await git(mirror, "checkout", "-q", "-B", `bench/${name}`, ref);
    await overlayTests(chain.tasks[name] as Task, name, mirror);
    await git(mirror, "add", "-f", "benchtests");
    await git(mirror, "commit", "-q", "-m", `${name} hidden tests`);
    squash[name] = await git(mirror, "rev-parse", "HEAD");
    trees[`S${index + 1}`] = await git(mirror, "rev-parse", "HEAD^{tree}");
  }
  await git(mirror, "checkout", "-q", "ref");
  const want = JSON.parse(await readFile(join(DATA, "trees.json"), "utf8")) as Record<
    string,
    string
  >;
  const different = Object.keys(want).filter((key) => trees[key] !== want[key]);
  if (different.length > 0) {
    throw new Error(`the rebuilt chain's trees are not the chain's: ${different.join(" ")}`);
  }
  console.log(`${Object.keys(want).length} of ${Object.keys(want).length} trees equal`);
  return { mirror, parent, squash };
}

/**
 * A fresh clone at `dest` whose history ends at `sha`, with `origin` reading the real URL (the project's
 * name is taken from it) and nothing of the mirror's path left in `.git`.
 */
export async function makeTree(
  chain: ChainData,
  rebuilt: Rebuilt,
  sha: string,
  dest: string,
): Promise<void> {
  const branch = `bench/${sha.slice(0, 12)}`;
  await git(rebuilt.mirror, "branch", "-f", branch, sha);
  await run("git", [
    "clone",
    "-q",
    "--single-branch",
    "--no-tags",
    "--branch",
    branch,
    `file://${rebuilt.mirror}`,
    dest,
  ]);
  await git(dest, "remote", "set-url", "origin", chain.repo.origin);
  await git(dest, "branch", "-m", branch, "main");
  await scrub(dest, rebuilt.mirror);
}

/** Takes out of `.git` what names the mirror (the clone's and the fetch's reflog entries, FETCH_HEAD). */
async function scrub(tree: string, mirror: string): Promise<void> {
  await rm(join(tree, ".git", "logs"), { recursive: true, force: true });
  for (const name of ["FETCH_HEAD", "ORIG_HEAD"])
    await rm(join(tree, ".git", name), { force: true });
  const left = await run("grep", ["-rl", "--", mirror, join(tree, ".git")], { allowFailure: true });
  if (left.stdout.trim() !== "")
    throw new Error(`the mirror's path is still in ${left.stdout.trim()}`);
}

/** The tree moved in place to `sha`, as when the project has moved on: what the session left is dropped. */
export async function resetTree(rebuilt: Rebuilt, sha: string, tree: string): Promise<void> {
  const branch = `bench/${sha.slice(0, 12)}`;
  await git(rebuilt.mirror, "branch", "-f", branch, sha);
  await git(tree, "fetch", "-q", "--no-tags", `file://${rebuilt.mirror}`, branch);
  await git(tree, "reset", "-q", "--hard", "FETCH_HEAD");
  await git(tree, "clean", "-qfdx");
  await scrub(tree, rebuilt.mirror);
}

/** What building ergo leaves in a tree is not an agent's edit of the source. */
export async function excludeBuildOutputs(
  tree: string,
  patterns: readonly string[],
): Promise<void> {
  await appendFile(join(tree, ".git", "info", "exclude"), `${patterns.join("\n")}\n`);
}
