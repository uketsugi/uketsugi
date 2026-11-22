/**
 * Copying what a session carries, so that no session's writing reaches another's. Everything is
 * copied (reflinked where the filesystem can), and nothing is linked: Go rewrites an existing build
 * cache entry's index file in place, so a hard link would let one session's build change what every
 * home linked to the same master sees. The Go build cache is the large part of a home (hundreds of
 * megabytes in thousands of small files); each home gets a private copy of the warm master, made
 * off the path (before the earlier session starts and while it runs), and a home carried forward
 * does not bring the cache of the session it comes from: the later session starts on a copy of the
 * master, which is the cache it would have found warm anyway.
 */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./process.ts";

/** Where Go keeps its build cache in a home. */
export const GO_CACHE = join(".cache", "go-build");

/** `cp -a`, reflinked where the filesystem can. */
export const copyTree = async (from: string, to: string): Promise<void> => {
  await run("cp", ["-a", "--reflink=auto", from, to]);
};

/** A private copy of the warm Go build cache `master` in `home`. */
export async function copyCache(master: string, home: string): Promise<void> {
  await mkdir(join(home, ".cache"), { recursive: true });
  await copyTree(master, join(home, GO_CACHE));
}

/** A home copied to `to`, all but the Go build cache, which each home takes from the master on its own. */
export async function copyHome(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from)) {
    if (entry !== ".cache") {
      await copyTree(join(from, entry), join(to, entry));
      continue;
    }
    await mkdir(join(to, ".cache"), { recursive: true });
    for (const sub of await readdir(join(from, ".cache")))
      if (join(".cache", sub) !== GO_CACHE)
        await copyTree(join(from, ".cache", sub), join(to, ".cache", sub));
  }
}
