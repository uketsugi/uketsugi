/**
 * What a run proves of itself from the evidence it kept, so that the first live unit shows each or
 * the run is void: the no-memory arm had no server (no `server.log` in its cases), and the memory
 * arm's later sessions had a server of their own that served the store E left (every fact of E's
 * store is in the later case's `facts.json`, which is read from that server).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoreFact } from "../recall/adapter.ts";
import { LATER } from "./pair.ts";
import type { RunFile } from "./score.ts";

const idsOf = async (path: string): Promise<string[]> =>
  existsSync(path)
    ? (JSON.parse(await readFile(path, "utf8")) as StoreFact[]).map((f) => f.id)
    : [];

/** The proofs that failed, in words; none when every one held. */
export async function proofsOf(out: string, run: RunFile): Promise<string[]> {
  const failed: string[] = [];
  const at = (unit: number, arm: string, role: string): string =>
    join(out, "cases", `u${unit}-${arm}-${role}`);
  for (const unit of run.units) {
    const ran = (s: { startedMs: number | null } | undefined): boolean => s?.startedMs != null;
    for (const role of ["E", ...LATER]) {
      const session = role === "E" ? unit.arms.none.earlier : unit.arms.none.later[role as "T4"];
      if (ran(session) && existsSync(join(at(unit.unit, "none", role), "server.log")))
        failed.push(`u${unit.unit} none ${role}: the no-memory arm had a server`);
    }
    const left = await idsOf(join(at(unit.unit, "memory", "E"), "facts.json"));
    for (const task of LATER) {
      if (!ran(unit.arms.memory.later[task])) continue;
      const served = await idsOf(join(at(unit.unit, "memory", task), "facts.json"));
      const missing = left.filter((id) => !served.includes(id));
      if (missing.length > 0)
        failed.push(
          `u${unit.unit} memory ${task}: the server on the carried store did not serve what E left (${missing.join(", ")})`,
        );
    }
  }
  return failed;
}
