import { execFileSync } from "node:child_process";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveHome } from "../src/home.ts";

test("a test run has a temporary home of its own: a verb's default data directory, and any process a test starts, are in it", () => {
  // The account's home as the password database has it, whatever the environment says.
  const real = userInfo().homedir;
  const home = homedir();

  expect(home).not.toBe(real);
  expect(home.startsWith(join(tmpdir(), "ukt-test-home-"))).toBe(true);
  expect(process.env["UKT_DATA_DIR"]).toBeUndefined();
  expect(resolveHome(undefined, process.env).dataDir).toBe(
    join(home, ".local", "share", "uketsugi"),
  );
  const started = execFileSync(process.execPath, ["-p", "require('node:os').homedir()"]);
  expect(started.toString().trim()).toBe(home);
});
