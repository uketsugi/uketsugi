/**
 * `pnpm --filter @uketsugi/e2e benchmark:replay <data folder> [--model <folder>] [--words-only] [--listed-order] [--brief-only]`
 *
 * Replays the kept recall probes' own queries through the product's search with no harness session
 * and no model provider, and says how often the fact that states the item comes back in the top 10,
 * and for each miss why. The data is not in the repository (`handoff/bench-data/replay/`). "With the
 * model" runs only when the folder holds the pinned runtime and model and every search used it; a
 * run that cannot say so is void. The model folder is `--model` or `UKT_MODEL_DIR`. Facts are
 * published in the order they were written; `--listed-order` publishes them as the data file lists
 * them (newest first), which is how round 3's scripts did. `--brief-only` prints only the brief's
 * figures (a needed fact listed, by told items and asides, and its length), in minutes: it skips the
 * searches, the explanations and the relaxation table, and the brief does not depend on the arm.
 */
import { loadReplayData, missingFiles, SHAPES } from "./data.ts";
import { loadModel, openEnv } from "./env.ts";
import { briefLines, sectionOf } from "./report.ts";
import { replayBriefs, replayShape } from "./replay.ts";

// The model's runtime tries to reach a telemetry host and leaves a file in the working directory.
process.env["ORT_DISABLE_TELEMETRY"] ??= "1";

function argumentsOf(argv: readonly string[]) {
  const dir = argv.find((arg, index) => !arg.startsWith("--") && argv[index - 1] !== "--model");
  const at = argv.indexOf("--model");
  return {
    dir,
    model: (at === -1 ? process.env["UKT_MODEL_DIR"] : argv[at + 1]) ?? null,
    wordsOnly: argv.includes("--words-only"),
    briefOnly: argv.includes("--brief-only"),
    order: argv.includes("--listed-order") ? ("listed" as const) : ("written" as const),
  };
}

async function main(): Promise<number> {
  const { dir, model, wordsOnly, briefOnly, order } = argumentsOf(process.argv.slice(2));
  if (dir === undefined) {
    console.error(
      "usage: benchmark:replay <data folder> [--model <folder>] [--words-only] [--listed-order] [--brief-only]",
    );
    return 2;
  }
  const missing = missingFiles(dir);
  if (missing.length > 0) {
    console.log(`no replay data in ${dir}: missing ${missing.join(", ")}. Nothing was run.`);
    return 0;
  }
  if (model === null && !wordsOnly && !briefOnly) {
    console.error(
      "the arm with the model needs --model <folder> (or UKT_MODEL_DIR), or --words-only",
    );
    return 2;
  }
  const data = loadReplayData(dir);
  console.log(
    `replay benchmark · ${dir} · ${data.labels.size} labels · no harness session, no model provider`,
  );
  for (const shape of briefOnly ? SHAPES : []) {
    const env = await openEnv(null);
    try {
      const rows = await replayBriefs(env, shape, data.shapes[shape], data.labels, order);
      console.log(briefLines(shape, rows).join("\n"));
    } finally {
      await env.close();
    }
  }
  for (const shape of briefOnly ? [] : SHAPES) {
    for (const arm of wordsOnly ? (["words"] as const) : (["words", "model"] as const)) {
      const env = await openEnv(arm === "model" && model !== null ? await loadModel(model) : null);
      try {
        const rows = await replayShape(env, shape, data.shapes[shape], data.labels, order);
        console.log(sectionOf(shape, arm, rows).join("\n"));
      } finally {
        await env.close();
      }
    }
  }
  return 0;
}

process.exitCode = await main();
