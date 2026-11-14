/**
 * The verbs that prepare this machine: `setup` (the data directory, the store, the token, the
 * embedding model) and `token` (print it, or replace it).
 */
import { TOKEN_ENV } from "@uketsugi/contracts";
import { issueToken, replaceTokens } from "@uketsugi/core";
import { CATALOG, installModel, verifyModel } from "@uketsugi/embed";
import { DEFAULT_HOST, DEFAULT_PORT, localUrl } from "@uketsugi/server";
import {
  ensureDataDir,
  ensureHostKey,
  readToken,
  readTokenFile,
  resolveHome,
  writeToken,
  type Home,
} from "./home.ts";
import { hostStore, requireStore, storePlace, withStore, type HostStore } from "./host-store.ts";
import { listening, onStore, type Listen, type OnStore, type Program } from "./program.ts";
import { CliFailure, confirmPlan, type Io, type Report } from "./report.ts";
import { numberOf } from "./serve.ts";
import { requireStopped } from "./server-client.ts";

export interface SetupOptions extends Listen, OnStore {
  readonly dataDir?: string;
  /** False with `--no-model`: the model is left out and search matches words only. */
  readonly model: boolean;
  readonly json?: boolean;
}

/** How the model step ended, as `setup` reports it. */
interface ModelStep {
  readonly state: "installed" | "present" | "skipped" | "unsupported";
  readonly text: string;
}

const WORDS_ONLY = "search will match words only, not meaning";

function modelFailure(what: string, next: string): CliFailure {
  return new CliFailure({
    what,
    meaning: `The data directory and the token are ready and \`ukt serve\` will run, but ${WORDS_ONLY}.`,
    next,
  });
}

/** Makes the model usable: verifies the directory `UKT_MODEL_DIR` names, or installs into ours. */
async function prepareModel(io: Io, home: Home, wanted: boolean): Promise<ModelStep> {
  if (!wanted) return { state: "skipped", text: `left out; ${WORDS_ONLY}` };
  if (!home.modelIsOurs) {
    const check = await verifyModel(home.modelDir);
    if (check.ok) return { state: "present", text: `${check.model}, verified in ${home.modelDir}` };
    throw modelFailure(
      `The model directory UKT_MODEL_DIR=${home.modelDir} cannot be used: ${check.detail}.`,
      "Point UKT_MODEL_DIR at a directory that holds the model, or unset it and run `ukt setup` again to install the model.",
    );
  }
  const progress = io.progress("Installing the embedding model (a download of about 170 MB)");
  const outcome = await installModel(home.modelDir, {
    onProgress: ({ name, received, total }) => progress.update(name, received, total),
  });
  progress.stop(outcome.ok ? "The embedding model is installed." : "The model was not installed.");
  if (outcome.ok) {
    const state = outcome.fetched ? "installed" : "present";
    return { state, text: `${outcome.model}, ${state} in ${home.modelDir}` };
  }
  if (outcome.reason === "unsupported_platform")
    return { state: "unsupported", text: `${outcome.detail}; ${WORDS_ONLY}` };
  throw outcome.reason === "fetch_failed"
    ? modelFailure(
        `The embedding model could not be downloaded: ${outcome.detail}.`,
        "Check the network connection and run `ukt setup` again. To go without the model: `ukt setup --no-model`.",
      )
    : modelFailure(
        `A downloaded file is not the pinned one: ${outcome.detail}.`,
        "Run `ukt setup` again. If it repeats, the source is serving other files than the ones this release pins: do not use them.",
      );
}

/** A word of a command as a shell reads it back: quoted where it holds anything a shell would split or expand. */
function word(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * The commands the person types next, with what this `setup` was told that they must be told
 * again: nothing but the store's place is kept from one verb to the next.
 */
export function nextCommands(options: SetupOptions): {
  serve: string;
  token: string;
  ui: string;
} {
  const dir = options.dataDir === undefined ? "" : ` --data-dir ${word(options.dataDir)}`;
  const host = options.host === DEFAULT_HOST ? "" : ` --host ${word(options.host)}`;
  const port = options.port === String(DEFAULT_PORT) ? "" : ` --port ${word(options.port)}`;
  return {
    serve: `ukt serve${dir}${host}${port}`,
    token: `export ${TOKEN_ENV}="$(ukt token${dir})"`,
    ui: `ukt ui${dir}`,
  };
}

/**
 * Makes the host's store and the person's first token, whichever is not there yet: the store is
 * opened, which creates it and records where it is, and a token is issued unless one is held.
 * Returns whether it issued one.
 */
async function ensureStoreAndToken(home: Home, store: HostStore): Promise<boolean> {
  const held = (await readToken(home)) !== null;
  if (held && store.made) return false;
  return withStore(home, store, async (local) => {
    if (held) return false;
    await writeToken(home, await issueToken(local.ports, local.owner, "made by ukt setup"));
    return true;
  });
}

/** `ukt setup`: everything `ukt serve` needs, made once; running it again changes nothing that is in place. */
export async function setup(
  io: Io,
  options: SetupOptions,
  env: NodeJS.ProcessEnv,
): Promise<Report> {
  const home = resolveHome(options.dataDir, env);
  const url = `${localUrl(options.host, numberOf(options.port, "--port", 0, 65535))}/mcp`;
  const store = await hostStore(home, options.databaseUrl);
  const madeDir = await ensureDataDir(home);
  const madeToken = await ensureStoreAndToken(home, store);
  await ensureHostKey(home);
  const model = await prepareModel(io, home, options.model);
  const onFile = (await readTokenFile(home)) !== null;
  const tokenText = onFile
    ? `${home.tokenFile}${madeToken ? " (created)" : ""}`
    : `taken from ${TOKEN_ENV}`;
  const next = nextCommands(options);
  return {
    data: {
      data_dir: home.dataDir,
      store: store.kind === "postgres" ? { kind: store.kind, database: store.name } : store,
      created: { data_dir: madeDir, token: madeToken },
      token_file: onFile ? home.tokenFile : null,
      model: { state: model.state, id: CATALOG.embedModel, dir: home.modelDir },
      mcp_url: url,
      next: [next.serve, next.token, "connect a harness"],
    },
    lines: [
      `data directory  ${home.dataDir}${madeDir ? " (created)" : ""}`,
      ...(store.kind === "postgres" ? [`store           ${storePlace(home, store)}`] : []),
      `token           ${tokenText}`,
      `model           ${model.text}`,
      `server URL      ${url}`,
      "",
      "Next:",
      `  1. Start the server:  ${next.serve}`,
      "  2. In another terminal, put your token where a harness's command reads it:",
      `       ${next.token}`,
      "  3. From that terminal, connect your harness.",
      `     \`${next.ui}\` opens the page that shows the lines to run for each harness.`,
      "",
      "An agent names its project by the repository's origin remote. For work in a directory",
      "without one, make a project name on the dashboard's Projects page.",
    ],
  };
}

export interface TokenOptions extends OnStore {
  readonly dataDir?: string;
  readonly rotate?: boolean;
  readonly yes?: boolean;
  readonly json?: boolean;
}

/**
 * `ukt token --rotate`: ends every token of the host's own person and stores the one new token.
 * The server must be stopped. Other people's tokens are not touched: `ukt revoke` ends one of those.
 */
async function rotate(io: Io, home: Home, options: TokenOptions): Promise<Report> {
  const store = await hostStore(home, options.databaseUrl);
  requireStore(home, store, "token --rotate");
  await requireStopped(home, "token --rotate");
  await confirmPlan(
    io,
    [
      `This replaces the token in ${home.tokenFile}.`,
      "Every token of yours issued so far stops working at once.",
      "Each harness is refused until it is given the new token.",
    ],
    options,
  );
  const fresh = await withStore(home, store, async (local) => {
    const made = await replaceTokens(local.ports, local.owner, "made by ukt token --rotate");
    await writeToken(home, made.token);
    return made;
  });
  const dir = options.dataDir === undefined ? "" : ` --data-dir ${word(options.dataDir)}`;
  return {
    data: { ...fresh },
    lines: [
      fresh.token,
      "Every earlier token of yours has stopped working.",
      "Next:",
      `  1. Start the server again:  ukt serve${dir}`,
      "  2. Give each harness the new token. A harness keeps the token it was given, so setting",
      `     ${TOKEN_ENV} is not enough. \`ukt ui${dir}\` opens the Connect page, which shows what to run`,
      "     again for each harness.",
      ...(home.givenToken === undefined
        ? []
        : [
            `This shell's ${TOKEN_ENV} still holds an old token: export ${TOKEN_ENV}="$(ukt token)"`,
          ]),
    ],
  };
}

/** `ukt token`: prints the token a harness sends. With `--rotate`, replaces it and ends the old ones. */
export async function token(
  io: Io,
  options: TokenOptions,
  env: NodeJS.ProcessEnv,
): Promise<Report> {
  const home = resolveHome(options.dataDir, env);
  if (options.rotate === true) return rotate(io, home, options);
  const held = await readToken(home);
  if (held === null)
    throw new CliFailure({
      what: `There is no token in ${home.tokenFile}.`,
      meaning: "No harness can be connected yet.",
      next: "Run `ukt setup`.",
    });
  return { data: { token: held }, lines: [held] };
}

/** Adds `setup` and `token` to the program. */
export function hostVerbs({ io, env, verb, run }: Program): void {
  onStore(
    listening(
      verb("setup", "make the data directory, the store and the token, and install the model"),
    ),
  )
    .option("--no-model", "leave the embedding model out; search then matches words only")
    .action((options: SetupOptions) => run("setup", options, () => setup(io, options, env)));
  onStore(verb("token", "print the token a harness sends"))
    .option("--rotate", "replace the token; every token of yours issued so far stops working")
    .option("--yes", "do not ask before replacing")
    .action((options: TokenOptions) => run("token", options, () => token(io, options, env)));
}
