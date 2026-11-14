/**
 * Vitest's global set-up for every run of the suite: the test processes get a home directory of
 * their own. A verb run without `--data-dir`, a child process a test starts, and anything else
 * that asks for the home directory or an XDG directory lands in a temporary folder that is removed
 * when the run ends, never in the home of whoever runs the tests. `UKT_DATA_DIR` is dropped for
 * the same reason: in the shell of a person who uses uketsugi it names their real store.
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
  delete process.env["UKT_DATA_DIR"];
  return () => rmSync(home, { recursive: true, force: true });
}
