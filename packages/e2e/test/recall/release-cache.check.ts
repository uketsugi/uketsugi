/** A release of a clean tree is built once per commit; a tree with changes is always built. */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildRelease } from "../../src/recall/release.ts";
import { Workspace } from "../../src/recall/workspace.ts";

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "recall-check-release-"));
  process.env["TMPDIR"] = root;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=n", ...args], { cwd });
};

test("the second build of a commit is taken from the cache, and a dirty tree is built again", async () => {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "packages", "cli"), { recursive: true });
  mkdirSync(join(repo, "deploy"));
  writeFileSync(join(repo, "packages", "cli", "package.json"), '{"version":"1.2.3"}');
  writeFileSync(
    join(repo, "deploy", "build.sh"),
    'cd "$(dirname "$0")/.." && echo built >> .builds && mkdir -p deploy/dist && cd deploy/dist && for f in uketsugi-1.2.3-linux-x64.tar.gz uketsugi-1.2.3-linux-x64.tar.gz.sha256 install.sh; do echo x > $f; done\n',
  );
  writeFileSync(join(repo, ".gitignore"), ".builds\ndeploy/dist\n");
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "one");
  const cache = join(root, "cache");
  const builds = (): number =>
    readFileSync(join(repo, ".builds"), "utf8").trim().split("\n").length;

  const workspace = await Workspace.create();
  const a = await buildRelease(workspace, repo, cache);
  expect(existsSync(join(a.dir, a.tarball))).toBe(true);
  expect(builds()).toBe(1);
  rmSync(workspace.at("release"), { recursive: true });

  const b = await buildRelease(workspace, repo, cache);
  expect(existsSync(join(b.dir, b.tarball))).toBe(true);
  expect(builds()).toBe(1);
  rmSync(workspace.at("release"), { recursive: true });

  appendFileSync(join(repo, "deploy", "build.sh"), "# changed\n");
  await buildRelease(workspace, repo, cache);
  expect(builds()).toBe(2);
  await workspace.close();
});
