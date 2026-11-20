/**
 * `pnpm --filter @uketsugi/e2e recall -- --prepare-only [--ergo <url|path>] [--out <dir>]`
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
 * SIGKILL leaves it for the next start to remove. `--prepare-only` does the set-up and the clean-up
 * with no session: it proves the rebuilt chain, judges every task, builds the working tree and
 * installs it. Its record goes to `result.json` in `--out`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { adapterFor, configurationOf, DEFAULT_MODEL, DEFAULT_PRODUCT } from "./adapters.ts";
import { loadChain } from "./chain.ts";
import { prepare } from "./prepare.ts";
import { preflight } from "./preflight.ts";
import { Workspace } from "./workspace.ts";

const USAGE =
  "usage: recall --prepare-only [--product uketsugi] [--config activate] [--model haiku] [--ergo <url|path>] [--out <dir>]";

async function main(): Promise<void> {
  // `pnpm recall -- --prepare-only` hands the script its own `--`: it is dropped, so both forms work.
  const args = process.argv.slice(2);
  const { values } = parseArgs({
    args: args[0] === "--" ? args.slice(1) : args,
    options: {
      "prepare-only": { type: "boolean" },
      product: { type: "string" },
      config: { type: "string" },
      model: { type: "string" },
      ergo: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help === true || values["prepare-only"] !== true) {
    console.log(USAGE);
    return;
  }
  const adapter = adapterFor(values.product ?? DEFAULT_PRODUCT);
  const config = configurationOf(adapter, values.config);
  console.log(
    `product ${adapter.name}, configuration ${config}, model ${values.model ?? DEFAULT_MODEL}`,
  );
  const chain = await loadChain();
  const tools = await preflight({ sessions: false });
  const out =
    values.out ??
    join(tmpdir(), "ukt-recall-results", new Date().toISOString().replace(/[:.]/g, "-"));
  const workspace = await Workspace.create();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void workspace.close().then(() => process.exit(signal === "SIGINT" ? 130 : 143));
    });
  }
  try {
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
  } finally {
    await workspace.close();
    console.log("workspace removed");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
