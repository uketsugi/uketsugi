/**
 * `pnpm --filter @uketsugi/e2e recall -- [--product uketsugi] [--config activate] [--model haiku]
 *   [--items D1,D5] [--quick|--full] [--gap 2] [--repeat 1] [--jobs 6] [--compare <result.json>]
 *   [--ergo <url|path>] [--out <dir>]`
 * `recall --rescore <results folder>` measures an earlier run again from the evidence it kept, with no session.
 * `recall --merge <first folder> <second folder> ...` completes a run with later ones.
 * `recall --prepare-only` does the set-up and clean-up with no session.
 *
 * What it measures: recall, the share of expected repeated research recalled from memory (needed
 * cells where memory delivered the item before the agent's first write to the tree, from what an
 * earlier session put there, over all needed cells). It is the first line of the output.
 *
 * The memory product (`--product`, default uketsugi), its configuration (`--config`, the product's
 * first) and the model the sessions run on (`--model`, default haiku) are chosen here and are data:
 * a product is an adapter (`adapter.ts`), registered in `adapters.ts`.
 *
 * The live end-to-end suite of Uketsugi's store and recall. It runs only when asked for: nothing of it
 * is collected by `pnpm test` or `pnpm check`, and `recall:check` runs its own checks of the suite.
 *
 * What it needs on the machine (each missing piece is named, with its fix, before anything starts):
 * bwrap, git, go, python3 with pytest and PyYAML, setpriv, curl, and for sessions the `claude`
 * program with a sign-in (CLAUDE_CODE_OAUTH_TOKEN, or CLAUDE_SIGN_IN naming the credentials file),
 * a model directory (UKT_MODEL_DIR) that `ukt setup` made, and for the model step a key file
 * (`--llm-key-file`, shell syntax, exporting GEMINI_API_KEY; the suite never reads it).
 *
 * It makes a workspace under the temporary folder (TMPDIR is honoured), clones ergo into it (GitHub,
 * or `--ergo`), and removes the workspace when it ends, on SIGINT and SIGTERM too; a run killed with
 * SIGKILL leaves it for the next start to remove. `--prepare-only` proves the rebuilt chain, judges
 * every task, builds the working tree and installs it; its record goes to `result.json` in `--out`.
 * A run rebuilds and proves the chain's trees, builds the working tree, and does not judge the tasks
 * again. Nothing stops a run on spend; the model step's spend is reported.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Adapter, AdapterContext } from "./adapter.ts";
import { adapterFor, configurationOf, DEFAULT_MODEL, DEFAULT_PRODUCT } from "./adapters.ts";
import { seedOf } from "./case.ts";
import { loadChain } from "./chain.ts";
import type { Scoring } from "./evidence.ts";
import { loadItems, type Items } from "./items.ts";
import { validatePatterns } from "./measure.ts";
import { DEFAULT_GAP } from "./plan.ts";
import { prepare } from "./prepare.ts";
import { preflight } from "./preflight.ts";
import { headline, table } from "./report.ts";
import { merge, rescore } from "./results.ts";
import { report, runSuite, type RunOptions } from "./suite.ts";
import { Workspace } from "./workspace.ts";

const USAGE = [
  "usage: recall [--product uketsugi] [--config activate] [--model haiku] [--items D1,D5] [--quick|--full]",
  "              [--gap 2] [--repeat 1] [--jobs 6] [--compare <result.json>] [--ergo <url|path>] [--out <dir>]",
  "              [--model-dir <dir>] [--llm-key-file <file>]",
  "       recall --rescore <results folder>",
  "       recall --merge <first folder> <second folder> ...",
  "       recall --prepare-only [--ergo <url|path>] [--out <dir>]",
].join("\n");

const OPTIONS = {
  "prepare-only": { type: "boolean" },
  rescore: { type: "string" },
  merge: { type: "boolean" },
  product: { type: "string" },
  config: { type: "string" },
  model: { type: "string" },
  items: { type: "string" },
  quick: { type: "boolean" },
  full: { type: "boolean" },
  gap: { type: "string" },
  repeat: { type: "string" },
  jobs: { type: "string" },
  compare: { type: "string" },
  ergo: { type: "string" },
  out: { type: "string" },
  "model-dir": { type: "string" },
  "llm-key-file": { type: "string" },
  help: { type: "boolean" },
} as const;

type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>["values"];

/** How a run is told what to do, and who may stop it. */
async function withWorkspace<T>(body: (workspace: Workspace) => Promise<T>): Promise<T> {
  const workspace = await Workspace.create();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void workspace.close().then(() => process.exit(signal === "SIGINT" ? 130 : 143));
    });
  }
  try {
    return await body(workspace);
  } finally {
    await workspace.close();
    console.log("workspace removed");
  }
}

async function prepareOnly(values: Values): Promise<void> {
  const chain = await loadChain();
  const tools = await preflight({ sessions: false });
  const out =
    values.out ??
    join(tmpdir(), "ukt-recall-results", new Date().toISOString().replace(/[:.]/g, "-"));
  await withWorkspace(async (workspace) => {
    const prepared = await prepare(workspace, tools, chain, values.ergo ?? chain.repo.origin);
    await mkdir(out, { recursive: true });
    const record = {
      format: 1,
      build: prepared.build,
      ukt: prepared.version,
      chain: chain.name,
      chainVerified: prepared.verified,
    };
    await writeFile(join(out, "result.json"), JSON.stringify(record, null, 2) + "\n");
    console.log(`result: ${join(out, "result.json")}`);
    if (!prepared.verified) process.exitCode = 1;
  });
}

async function scoringFor(
  product: string,
  mode: string,
): Promise<{ items: Items; scoring: Scoring }> {
  const items = await loadItems();
  const adapter = adapterFor(product);
  const seed = await seedOf();
  const scoring: Scoring = {
    items,
    seedClaims: new Set(seed.map((s) => String(s["claim"]))),
    boilerplate: adapter.boilerplate,
    mode,
  };
  return { items, scoring };
}

/** Refuses to start when an item's pattern matches what no earlier session put there. */
async function refuseBrokenPatterns(adapter: Adapter, items: Items): Promise<void> {
  const seed = (await seedOf()) as { claim: string; detail?: string }[];
  const problems = validatePatterns(items, seed, adapter.boilerplate);
  if (problems.length > 0) {
    throw new Error(
      `refusing to start: an item's pattern matches what no earlier session put there:\n${problems.join("\n")}`,
    );
  }
}

async function afterTheFact(values: Values, folders: string[]): Promise<void> {
  const mode = values.full === true ? "full" : "quick";
  const first = values.rescore ?? folders[0] ?? "";
  const old = JSON.parse(await readFile(join(first, "result.json"), "utf8")) as { product: string };
  const { items, scoring } = await scoringFor(old.product, mode);
  const result =
    values.rescore !== undefined ? await rescore(values.rescore, scoring) : await merge(folders);
  console.log(headline(result));
  console.log(table(result, items));
  console.log(JSON.stringify(result.totals, null, 1));
}

function integer(value: string | undefined, fallback: number, name: string): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} takes a whole number`);
  return n;
}

async function run(values: Values): Promise<void> {
  const adapter = adapterFor(values.product ?? DEFAULT_PRODUCT);
  const configs = (values.config ?? adapter.configurations[0])
    .split(",")
    .map((c) => configurationOf(adapter, c));
  const model = values.model ?? DEFAULT_MODEL;
  const { items, scoring } = await scoringFor(
    adapter.name,
    values.full === true ? "full" : "quick",
  );
  const names = values.items === undefined ? Object.keys(items) : values.items.split(",");
  const unknown = names.filter((n) => !(n in items));
  if (unknown.length > 0) throw new Error(`no such item: ${unknown.join(", ")}`);
  await refuseBrokenPatterns(adapter, items);
  const modelDir = values["model-dir"] ?? process.env["UKT_MODEL_DIR"];
  if (modelDir === undefined)
    throw new Error(
      "the embedding model: pass --model-dir or set UKT_MODEL_DIR (a directory `ukt setup` made)",
    );
  const chain = await loadChain();
  const tools = await preflight({ sessions: true });
  const jobs = integer(values.jobs, 6, "jobs");
  const options: RunOptions = {
    adapter,
    configs,
    items: names,
    mode: scoring.mode as "quick" | "full",
    gap: integer(values.gap, DEFAULT_GAP, "gap"),
    repeat: Math.max(1, integer(values.repeat, 1, "repeat")),
    jobs: Math.min(6, Math.max(1, jobs)),
    out:
      values.out ??
      join(
        tmpdir(),
        "ukt-recall-results",
        `${new Date().toISOString().replace(/[:.]/g, "-")}-${adapter.name}-${configs.join("-")}-${scoring.mode}-cases`,
      ),
    ...(values.compare === undefined ? {} : { compare: values.compare }),
  };
  await withWorkspace(async (workspace) => {
    const prepared = await prepare(
      workspace,
      tools,
      chain,
      values.ergo ?? chain.repo.origin,
      false,
    );
    const context: AdapterContext = {
      workspace,
      tools,
      release: prepared.release,
      releaseHome: prepared.home,
      modelDir,
      model,
      ...(values["llm-key-file"] === undefined ? {} : { llmKeyFile: values["llm-key-file"] }),
    };
    const result = await runSuite(options, prepared, context, tools, items, scoring);
    await report(result, items, options.out, options.compare);
    if (result.cases.some((c) => c.error !== undefined)) process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  // `pnpm recall -- --prepare-only` hands the script its own `--`: it is dropped, so both forms work.
  const args = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: args[0] === "--" ? args.slice(1) : args,
    options: OPTIONS,
    allowPositionals: true,
  });
  if (values.help === true) console.log(USAGE);
  else if (values["prepare-only"] === true) await prepareOnly(values);
  else if (values.rescore !== undefined || values.merge === true)
    await afterTheFact(values, positionals);
  else await run(values);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
