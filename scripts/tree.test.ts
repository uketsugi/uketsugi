import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { treeFaults, type Tree } from "./tree.ts";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((path) => path !== "");
const real: Tree = { files: tracked, read: (path) => readFileSync(join(root, path)) };

/** The real tree with changes: a file's new text, or null to take it out, and files it does not have. */
function planted(changes: Record<string, string | Buffer | null>): Tree {
  const files = [
    ...tracked.filter((p) => changes[p] !== null),
    ...Object.keys(changes).filter((p) => !tracked.includes(p) && changes[p] !== null),
  ];
  return {
    files,
    read: (path) => {
      const change = changes[path];
      return change === undefined || change === null ? real.read(path) : Buffer.from(change);
    },
  };
}
const edit = (path: string, from: string | RegExp, to: string) => ({
  [path]: real.read(path).toString("utf8").replace(from, to),
});

describe("the tracked tree", () => {
  it("holds no document, built output or second statement of a fact", () => {
    expect(treeFaults(real)).toEqual([]);
  });

  describe("fails on", () => {
    it.each([
      ["a plan", { "PLAN.md": "# plan" }],
      ["a design note in a package", { "packages/core/NOTES.md": "x" }],
      ["a document in another format", { "docs/report.pdf": "%PDF" }],
      ["a release archive", { "deploy/uketsugi-0.2.0-linux-x64.tar.gz": "x" }],
      ["a dist folder", { "packages/web/dist/index.html": "<html>" }],
      ["an executable", { "deploy/ukt-bin": Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]) }],
      ["a model", { "models/embed.onnx": "x" }],
    ])("%s", (_what, change) => {
      expect(treeFaults(planted(change)).join("\n")).toContain(Object.keys(change)[0]);
    });

    it("but not on a plugin's rules file, which a harness reads", () => {
      expect(treeFaults(real).filter((f) => f.includes("AGENTS.md"))).toEqual([]);
    });
  });

  describe("fails on a second statement of", () => {
    const version = (
      JSON.parse(real.read("packages/cli/package.json").toString("utf8")) as { version: string }
    ).version;

    it.each([
      "README.md",
      "deploy/Dockerfile",
      "deploy/compose.yaml",
      "packages/core/package.json",
    ])("the version, in %s", (path) => {
      const text = real.read(path).toString("utf8");
      const faults = treeFaults(planted({ [path]: `${text}\nuketsugi ${version}\n` }));
      expect(faults.join("\n")).toContain(`${path} states the version`);
    });

    it("a harness's line, written differently from what the server renders", () => {
      const faults = treeFaults(
        planted(
          edit("README.md", "agy mcp add uketsugi http", "agy mcp add --scope user uketsugi http"),
        ),
      );
      expect(faults.join("\n")).toContain("Antigravity");
    });

    it("a limit, said differently from the source", () => {
      const faults = treeFaults(
        planted(edit("README.md", "holds at most 100 turns", "holds at most 90 turns")),
      );
      expect(faults.join("\n")).toContain("README.md says turns kept is 90");
    });
  });
});
