/**
 * Opens an embedded store as `ukt serve` does and says what happened, one JSON line each: every
 * recovery report as `{"progress": …}`, then the ids of the facts the opened store holds as
 * `{"facts": […]}`, or `{"failed": <error's name>}` after trying to take the directory's lock
 * again, which says whether the failed open gave it back as `{"lock": "free"}`. With HOLD_DIR set,
 * it also writes `recovered` to HOLD_DIR/log when the
 * recovery is done, so a test reads in one file the order of what the threads did.
 * Run as: node --import ./hold-syncs.ts --conditions=@uketsugi/source open.ts <dataDir>
 */
import { appendFileSync } from "node:fs";
import { scopeOf } from "@uketsugi/core";
import { lockDataDir } from "../../src/data-dir.ts";
import { openEmbeddedStore } from "../../src/index.ts";
import { sampleOwner } from "./sample.ts";

const [dataDir = ""] = process.argv.slice(2);
const log = process.env.HOLD_DIR === undefined ? null : `${process.env.HOLD_DIR}/log`;
const say = (what: object): void => console.log(JSON.stringify(what));

try {
  const store = await openEmbeddedStore({
    dataDir,
    lockStaleMs: 2000,
    onRecovery: (progress) => {
      say({ progress });
      if (progress.phase === "done" && log !== null) appendFileSync(log, "recovered\n");
    },
  });
  const scope = scopeOf(await sampleOwner(store));
  say({ facts: (await store.facts.list(scope, { limit: 1000 })).map((fact) => fact.id) });
  await store.close();
} catch (error) {
  say({ failed: error instanceof Error ? error.name : String(error) });
  const release = await lockDataDir(dataDir);
  say({ lock: "free" });
  await release();
}
