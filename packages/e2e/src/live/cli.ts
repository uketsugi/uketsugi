/**
 * `pnpm --filter @uketsugi/e2e live -- --ergo <local mirror of ergo> --reading-from <earlier run's folder>
 *   [--config setup] [--units N | --width width.json] [--pool <earlier run folders>] [--out <dir>]`
 *     runs the live-hour test (`handoff/lanes/done/live-hour/design.md`): every unit in both arms at once,
 *     and prints the result by minute 55. It refuses to start without a reading of the seven-day window
 *     (the newest rate-limit event in the earlier run's kept transcripts) and fetches nothing.
 * `live --prepare-only --ergo <mirror> [--units N]`  set-up with no task session, timed.
 * `live --calibrate --ergo <mirror> [--provider-k N]`                  measures the machine and the provider, writes width.json.
 * `live --memcheck`                                   whether the harness's own memory is read in a later session.
 * `live --rescore <run folder> [--pool <earlier run folders>]`  scores a kept run with no session.
 *
 * Needs, as the recall suite does: bwrap, git, go, python3 with pytest and PyYAML, setpriv, curl,
 * `claude` signed in (CLAUDE_CODE_OAUTH_TOKEN, or CLAUDE_SIGN_IN naming the credentials file), and
 * the embedding model (UKT_MODEL_DIR or --model-dir).
 */
import { parseArgs } from "node:util";
import { loadItems } from "../recall/items.ts";
import { uketsugi } from "../recall/uketsugi.ts";
import { poolSection } from "./pool.ts";
import { render } from "./report.ts";
import { scoreRun, type Scoring } from "./score.ts";
import { liveCalibrate, liveMemcheck, liveRun, prepareOnly } from "./start.ts";

const USAGE = [
  "usage: live --ergo <mirror> --reading-from <earlier run folder> [--config setup] [--units N | --width width.json] [--pool a,b] [--out dir]",
  "       live --prepare-only --ergo <mirror> [--units N]",
  "       live --calibrate --ergo <mirror> [--provider-k N]",
  "       live --memcheck",
  "       live --rescore <run folder> [--pool a,b]",
].join("\n");

const OPTIONS = {
  rescore: { type: "string" },
  "prepare-only": { type: "boolean" },
  calibrate: { type: "boolean" },
  memcheck: { type: "boolean" },
  ergo: { type: "string" },
  config: { type: "string" },
  model: { type: "string" },
  units: { type: "string" },
  out: { type: "string" },
  "model-dir": { type: "string" },
  "reading-from": { type: "string" },
  width: { type: "string" },
  pool: { type: "string" },
  "provider-k": { type: "string" },
  help: { type: "boolean" },
} as const;

async function rescore(folder: string, pool: readonly string[]): Promise<string> {
  const scoring: Scoring = {
    items: await loadItems(),
    spec: uketsugi.memory,
    boilerplate: uketsugi.boilerplate,
  };
  const run = await scoreRun(folder, scoring);
  const earlier = await Promise.all(pool.map((f) => scoreRun(f, scoring)));
  return render(run.meta, run.units, poolSection(run, earlier));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { values } = parseArgs({ args: args[0] === "--" ? args.slice(1) : args, options: OPTIONS });
  if (values.help === true) console.log(USAGE);
  else if (values.rescore !== undefined)
    console.log(await rescore(values.rescore, values.pool?.split(",") ?? []));
  else if (values["prepare-only"] === true) await prepareOnly(values);
  else if (values.calibrate === true) await liveCalibrate(values);
  else if (values.memcheck === true) await liveMemcheck(values);
  else await liveRun(values);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
