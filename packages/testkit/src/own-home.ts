/**
 * Vitest's global set-up for every run of the suite: the test processes get a home directory of
 * their own. A verb run without `--data-dir`, a child process a test starts, and anything else
 * that asks for the home directory or an XDG directory lands in a temporary folder that is removed
 * when the run ends, never in the home of whoever runs the tests. The `UKT_` variables are dropped
 * for the same reason: in the shell of a person who uses uketsugi they name their real store, token,
 * port and model. What a test means to set, it sets itself. The run's own settings are kept:
 * `UKT_TEST_` (the PostgreSQL server) and `UKT_STRESS_` (the length of the stress run).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function ownHome(): () => void {
  const home = mkdtempSync(join(tmpdir(), "ukt-test-home-"));
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
  });
  for (const name of Object.keys(process.env))
    if (name.startsWith("UKT_") && !/^UKT_(TEST|STRESS)_/.test(name)) delete process.env[name];
  return () => rmSync(home, { recursive: true, force: true });
}
