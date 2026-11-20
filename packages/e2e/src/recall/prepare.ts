/**
 * The workspace's set-up, as a run and as `recall --prepare-only` do it: clone ergo, rebuild the chain
 * and prove it, judge every task red at its parent and green at its squash, build the working tree,
 * install the release. Each step says what it is doing as it starts.
 */
import { makeTree, rebuildChain, type ChainData, type Rebuilt } from "./chain.ts";
import { judge, type Judgement, type JudgeContext } from "./judge.ts";
import type { Tools } from "./preflight.ts";
import {
  buildRelease,
  describeBuild,
  installRelease,
  REPOSITORY,
  type Build,
  type Release,
} from "./release.ts";
import type { Workspace } from "./workspace.ts";

export interface Prepared {
  readonly chain: ChainData;
  readonly rebuilt: Rebuilt;
  readonly release: Release;
  readonly build: Build;
  readonly version: string;
  readonly home: string;
  /** Every task was red at its parent and green at its squash. */
  readonly verified: boolean;
  /** What judging a tree in the sandbox needs. */
  readonly judge: JudgeContext;
}

const say = (line: string): void => console.log(line);

async function judgeTask(
  context: JudgeContext,
  rebuilt: Rebuilt,
  workspace: Workspace,
  task: string,
): Promise<string> {
  const at = async (side: "parent" | "squash", sha: string): Promise<Judgement> => {
    const tree = workspace.at("trees", `${task}-${side}`);
    await makeTree(context.chain, rebuilt, sha, tree);
    return judge(context, task, tree);
  };
  const parent = await at("parent", rebuilt.parent[task] as string);
  const squash = await at("squash", rebuilt.squash[task] as string);
  const shown = `${task}: parent ${parent.passed ? "green" : "red"}, squash ${squash.passed ? "green" : "red"}`;
  if (!parent.passed && squash.passed) return `${shown} -> ok`;
  const failing = parent.passed ? parent : squash;
  return `${shown} -> WRONG\n    ${failing.tail.replace(/\n/g, "\n    ")}`;
}

/** Judges every task red at its parent and green at its squash, printing each row as it is known. */
export async function judgeChain(
  context: JudgeContext,
  rebuilt: Rebuilt,
  workspace: Workspace,
): Promise<boolean> {
  let allOk = true;
  for (const task of Object.keys(context.chain.tasks)) {
    const row = await judgeTask(context, rebuilt, workspace, task);
    say(row);
    allOk &&= row.endsWith("-> ok");
  }
  return allOk;
}

export async function prepare(
  workspace: Workspace,
  tools: Tools,
  chain: ChainData,
  ergo: string,
  verify = true,
): Promise<Prepared> {
  say(`workspace ${workspace.path}`);
  say(`cloning ergo from ${ergo}, rebuilding the chain`);
  const rebuilt = await rebuildChain(chain, ergo, workspace.at("mirror"));
  const context: JudgeContext = {
    chain,
    tools,
    workspace: workspace.path,
    hide: [workspace.path, REPOSITORY],
  };
  let verified = true;
  if (verify) {
    say("judging every task at its parent and at its squash, in the sandbox");
    verified = await judgeChain(context, rebuilt, workspace);
  }
  say("building the working tree");
  const build = await describeBuild(REPOSITORY);
  const release = await buildRelease(workspace);
  const home = workspace.at("ukt-home");
  const version = await installRelease(release, home);
  say(
    `installed: ukt --version ${version} (commit ${build.head.slice(0, 12)}${build.dirty ? ", dirty" : ""})`,
  );
  return { chain, rebuilt, release, build, version, home, verified, judge: context };
}
