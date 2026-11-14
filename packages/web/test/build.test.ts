/**
 * The built dashboard is what the server serves: `dist/`, with `index.html` answered for every
 * page address and never kept, and everything under `assets/` kept for good by its hashed name.
 * These tests build afresh and hold the build to that, and hold `dist/` to the build.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const root = join(import.meta.dirname, "..");
const served = join(root, "dist");

/** Every file under a folder, by its path from the folder, with a digest of its bytes. */
async function digests(folder: string): Promise<Record<string, string>> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const pairs = await Promise.all(
    files.map(async (file) => {
      const path = join(file.parentPath, file.name);
      const digest = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      return [relative(folder, path), digest] as const;
    }),
  );
  return Object.fromEntries(pairs.sort(([a], [b]) => a.localeCompare(b)));
}

describe("the built dashboard", () => {
  let fresh = "";

  beforeAll(async () => {
    fresh = await mkdtemp(join(tmpdir(), "uketsugi-web-"));
    // The test runner sets NODE_ENV to "test"; a release is built as production.
    vi.stubEnv("NODE_ENV", "production");
    await build({
      root,
      configFile: join(root, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir: fresh },
    });
    vi.unstubAllEnvs();
  });

  afterAll(() => rm(fresh, { recursive: true, force: true }));

  it("is one page, never kept, and assets the browser may keep for good by their hashed names", async () => {
    const paths = Object.keys(await digests(fresh));
    expect(paths).toContain("index.html");
    const assets = paths.filter((path) => path !== "index.html");
    expect(assets.length).toBeGreaterThan(0);
    for (const path of assets) expect(path).toMatch(/^assets\/[\w.-]+-[\w-]{8}\.(js|css|svg)$/);
  });

  it("loads only its own files, by addresses that hold at any page address", async () => {
    const page = await readFile(join(fresh, "index.html"), "utf8");
    const loaded = [...page.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(loaded.length).toBeGreaterThan(0);
    for (const address of loaded) {
      expect(address).toMatch(/^\/assets\//);
      expect(existsSync(join(fresh, address))).toBe(true);
    }
    // The server's policy allows scripts from its own origin only: an inline one would not run.
    expect(page).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(page).toMatch(/<html lang="en">/);
  });

  it("names the tab's icon, a file of its own", async () => {
    const page = await readFile(join(fresh, "index.html"), "utf8");
    const icon = /<link rel="icon" type="image\/svg\+xml" href="(\/assets\/[^"]+\.svg)"/.exec(page);
    expect(icon).not.toBeNull();
    expect(await readFile(join(fresh, icon?.[1] ?? ""), "utf8")).toMatch(/^<svg /);
  });

  it.skipIf(!existsSync(served))("equals dist/, which the server serves", async () => {
    // A failure here means dist/ is stale: run `pnpm --filter @uketsugi/web build`.
    expect(await digests(served)).toEqual(await digests(fresh));
  });
});
