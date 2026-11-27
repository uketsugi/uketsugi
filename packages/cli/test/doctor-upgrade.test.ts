import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connectMcp } from "@uketsugi/testkit";
import { describe, expect, test } from "vitest";
import { checkCalls, startFailureFinding } from "../src/doctor-upgrade.ts";
import { resolveHome } from "../src/home.ts";
import { token } from "../src/host-verbs.ts";
import { serve } from "../src/serve.ts";
import { fakeIo, tempDir } from "./support.ts";
import { version } from "../src/version.ts";
import { mkdir, writeFile } from "node:fs/promises";

describe("ukt doctor says whether a harness reached the server lately", () => {
  test("says a server nobody has called is installed and not yet in use, then who called and when", async () => {
    const dataDir = join(await tempDir(), "data");
    const serving = await serve(fakeIo(), { dataDir, host: "127.0.0.1", port: "0" }, {});
    try {
      const home = resolveHome(dataDir, {});
      const none = await checkCalls(home);
      const held = (await token(fakeIo(), { dataDir }, {})).lines[0] ?? "";
      const client = await connectMcp({
        url: `${String(serving.report.data["url"])}/mcp`,
        token: held,
        client: { name: "claude-code", version: "2.1.325" },
      });
      await client.callTool("search_facts", { project: "github.com/acme/api", query: "x" });
      await client.close();
      const some = await checkCalls(home);

      expect(none).toEqual([
        expect.objectContaining({
          state: "ok",
          detail:
            "no harness has called this server in the last 7 days: it is installed, not yet in use",
        }),
      ]);
      expect(some[0]?.detail).toMatch(
        /^claude-code 2\.1\.325: last call 0 minutes ago, 1 session in 7 days$/,
      );
    } finally {
      await serving.close();
    }
  });
});

describe("a start that fails", () => {
  test("keeps its reason although the data directory did not exist yet, and doctor gives the reason and its way out", async () => {
    const dataDir = join(await tempDir(), "not-made-yet");

    await expect(serve(fakeIo(), { dataDir, port: "seventy" }, {})).rejects.toThrow();
    const home = resolveHome(dataDir, {});

    expect(await readFile(home.startFailureFile, "utf8")).toContain('"seventy" is not a value');
    const finding = await startFailureFinding(home, "not running");
    expect(finding).toMatchObject({
      check: "server",
      state: "fail",
      fix: "Pass a whole number from 0 to 65535.",
    });
  });
});

describe("ukt --version", () => {
  test("says what a release's own VERSION file says, so that a candidate is not taken for the release", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "bin"));
    await writeFile(join(dir, "VERSION"), "uketsugi 0.3.0+140a0fb\nnode v24\n");
    const env = { UKT_LAUNCHER: join(dir, "bin", "ukt") };

    expect(version(env)).toBe("0.3.0+140a0fb");
    await writeFile(join(dir, "VERSION"), "uketsugi 0.3.0\n");
    expect(version(env)).toBe("0.3.0");
    // Run from source, or from a folder with no VERSION, the package's own version stands.
    expect(version({})).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version({ UKT_LAUNCHER: join(await tempDir(), "bin", "ukt") })).toMatch(/^\d+\./);
  });
});
