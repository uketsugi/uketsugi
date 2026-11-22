/**
 * Copying a home: every home has a private copy of the Go build cache, and nothing a session writes
 * can reach another home or the warm master. (Linking the cache was tried and fails this check:
 * Go rewrites an existing entry's index file in place, so a link lets one build change what every
 * home linked to the master sees.)
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { copyCache, copyHome } from "../../src/recall/copy.ts";

let root = "";
beforeAll(() => (root = mkdtempSync(join(tmpdir(), "recall-check-live-copy-"))));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Every file under `dir`: its bytes' hash, its modification time and its inode. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!name.isFile()) continue;
    const path = join(name.parentPath, name.name);
    const stat = statSync(path);
    out[path.slice(dir.length)] =
      `${createHash("sha256").update(readFileSync(path)).digest("hex")} ${stat.mtimeMs} ${stat.ino}`;
  }
  return out;
}

test("a home copy takes everything but the Go cache, which each home takes from the master on its own", async () => {
  const from = join(root, "from");
  mkdirSync(join(from, ".cache", "go-build", "ab"), { recursive: true });
  mkdirSync(join(from, ".cache", "other"), { recursive: true });
  mkdirSync(join(from, ".claude", "projects", "p", "memory"), { recursive: true });
  writeFileSync(join(from, ".cache", "go-build", "ab", "entry"), "the session's own cache");
  writeFileSync(join(from, ".cache", "other", "x"), "x");
  writeFileSync(join(from, ".claude.json"), "{}");
  writeFileSync(join(from, ".claude", "projects", "p", "memory", "note.md"), "remembered");
  const master = join(root, "master", "go-build");
  mkdirSync(join(master, "ab"), { recursive: true });
  writeFileSync(join(master, "ab", "entry"), "warm");
  const to = join(root, "to");
  await copyCache(master, to);

  await copyHome(from, to);

  for (const rest of [".cache/other/x", ".claude.json", ".claude/projects/p/memory/note.md"])
    expect(statSync(join(to, rest)).ino, rest).not.toBe(statSync(join(from, rest)).ino);
  // the cache in the copy is the master's, not the home it came from, and a copy of it
  expect(readFileSync(join(to, ".cache", "go-build", "ab", "entry"), "utf8")).toBe("warm");
  expect(statSync(join(to, ".cache", "go-build", "ab", "entry")).ino).not.toBe(
    statSync(join(master, "ab", "entry")).ino,
  );
  writeFileSync(join(to, ".claude", "projects", "p", "memory", "note.md"), "changed");
  expect(readFileSync(join(from, ".claude", "projects", "p", "memory", "note.md"), "utf8")).toBe(
    "remembered",
  );
});

test("a go build -a in one home changes no byte and no timestamp in another home's cache or in the master", async () => {
  const program = join(root, "program");
  mkdirSync(program, { recursive: true });
  writeFileSync(join(program, "go.mod"), "module probe\n\ngo 1.21\n");
  writeFileSync(
    join(program, "main.go"),
    'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("probe") }\n',
  );
  const env = { ...process.env, GOPROXY: "off", GOTOOLCHAIN: "local", GOFLAGS: "-mod=mod" };
  const master = join(root, "go-master", "go-build");
  mkdirSync(master, { recursive: true });
  execFileSync("go", ["build", "-o", join(root, "probe-bin"), "."], {
    cwd: program,
    env: { ...env, GOCACHE: master },
  });
  const [a, b] = [join(root, "home-a"), join(root, "home-b")];
  await copyCache(master, a);
  await copyCache(master, b);
  const [masterBefore, bBefore, aBefore] = [
    snapshot(master),
    snapshot(join(b, ".cache", "go-build")),
    snapshot(join(a, ".cache", "go-build")),
  ];
  expect(Object.keys(masterBefore).length).toBeGreaterThan(10);

  execFileSync("go", ["build", "-a", "-o", join(root, "probe-bin-a"), "."], {
    cwd: program,
    env: { ...env, GOCACHE: join(a, ".cache", "go-build") },
  });

  expect(snapshot(master)).toEqual(masterBefore);
  expect(snapshot(join(b, ".cache", "go-build"))).toEqual(bBefore);
  // the build did write in its own home: the check is not empty
  expect(snapshot(join(a, ".cache", "go-build"))).not.toEqual(aBefore);
}, 300_000);
