/**
 * The release under test: built by `deploy/build.sh` from the working tree as it stands (uncommitted
 * changes included, the commit and the diff recorded), its three files copied into the workspace at
 * once so that another build cannot change them mid-run, and installed into a home of its own.
 */
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./process.ts";
import type { Workspace } from "./workspace.ts";

export const REPOSITORY = fileURLToPath(new URL("../../../..", import.meta.url));
const MINIMAL_PATH = "/usr/bin:/bin";

export interface Build {
  readonly head: string;
  /** Tracked files differ from HEAD, or untracked files are there. */
  readonly dirty: boolean;
  /** sha256 of `git diff HEAD`; untracked files are not in it. */
  readonly diffSha256: string;
}

export interface Release {
  readonly dir: string;
  readonly tarball: string;
  readonly installScript: string;
}

export async function describeBuild(repo: string): Promise<Build> {
  const git = async (...args: string[]): Promise<string> =>
    (await run("git", args, { cwd: repo })).stdout;
  const diff = await git("diff", "HEAD");
  const status = await git("status", "--porcelain");
  return {
    head: (await git("rev-parse", "HEAD")).trim(),
    dirty: status.trim() !== "",
    diffSha256: createHash("sha256").update(diff).digest("hex"),
  };
}

/** Builds the working tree and copies the release into `<workspace>/release`. */
export async function buildRelease(workspace: Workspace, repo = REPOSITORY): Promise<Release> {
  await run("bash", [join(repo, "deploy", "build.sh")], { cwd: repo });
  const dist = join(repo, "deploy", "dist");
  const dir = workspace.at("release");
  await mkdir(dir);
  const manifest = JSON.parse(
    await readFile(join(repo, "packages", "cli", "package.json"), "utf8"),
  ) as {
    version: string;
  };
  const tarball = `uketsugi-${manifest.version}-linux-x64.tar.gz`; // the name build.sh gives it
  for (const name of [tarball, `${tarball}.sha256`, "install.sh"]) {
    await copyFile(join(dist, name), join(dir, name));
  }
  return { dir, tarball, installScript: join(dir, "install.sh") };
}

/** Installs the release into `home`, as a person would, with no other tool of the machine's on PATH. */
export async function installRelease(release: Release, home: string): Promise<string> {
  await mkdir(home, { recursive: true });
  const env = { HOME: home, PATH: MINIMAL_PATH, LANG: "C.UTF-8" };
  await run("sh", [release.installScript, "--tarball", join(release.dir, release.tarball)], {
    env,
  });
  const ukt = join(home, ".local", "bin", "ukt");
  const version = await run(ukt, ["--version"], { env });
  return version.stdout.trim();
}
