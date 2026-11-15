/** `ukt serve`: the server on this machine's data directory, until it is told to stop. */
import { TOKEN_ENV } from "@uketsugi/contracts";
import { RevokedTokenError, type DigestReport } from "@uketsugi/core";
import { CATALOG, openLocalEmbedder, type LocalEmbedder } from "@uketsugi/embed";
import {
  DEFAULT_DAILY_TOKENS,
  loopbackOfEvery,
  modelName,
  startLocalServer,
} from "@uketsugi/server";
import {
  ensureDataDir,
  ensureHostKey,
  readTokenFile,
  removeRecord,
  resolveHome,
  writeRecord,
  writeToken,
  type Home,
} from "./home.ts";
import {
  hostStore,
  rememberStore,
  storeFailure,
  storeOptions,
  storePlace,
  type HostStore,
} from "./host-store.ts";
import { hostModel, llmOptions, sentLine, type LlmOptions } from "./llm.ts";
import {
  onStore,
  serving,
  servingOf,
  type OnStore,
  type Program,
  type Serving as Told,
} from "./program.ts";
import { CliFailure, describe, type Io, type Report } from "./report.ts";
import { servingNow } from "./server-client.ts";
import { SERVICE_COMMANDS, serves, serviceState, UNIT } from "./service.ts";

/** What `ukt serve` is told. How the server runs is what it is told here, else what `ukt setup` kept. */
export interface ServeOptions extends Told, OnStore, LlmOptions {
  readonly dataDir?: string;
  readonly json?: boolean;
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** What the model step did with one session, as the server's terminal shows it: counts and cost, never text. */
export function digestLine(report: DigestReport): string {
  const { refused, day } = report;
  const left = refused.uncited + refused.repeat + refused.invalid;
  const why = `${refused.uncited} without a source, ${refused.repeat} already held, ${refused.invalid} not valid`;
  const budget = `${day.used} of ${day.limit} tokens used in the last day`;
  if (report.waited)
    return `language model: session ${report.session} waits, the day's budget is reached (${budget})`;
  return [
    `language model: read session ${report.session}`,
    `wrote ${count(report.written, "fact")}`,
    ...(left === 0 ? [] : [`left out ${left} (${why})`]),
    ...(report.merged === 0 ? [] : [`merged ${report.merged}`]),
    ...(report.flagged === 0 ? [] : [`raised ${count(report.flagged, "flag")}`]),
    ...(report.chose ? ["chose the next brief's facts"] : []),
    ...(report.unread === 0
      ? []
      : [
          `${count(report.unread, "turn")} dropped unread, the session reached what a session may cost`,
        ]),
    `${report.tokens.input} tokens in, ${report.tokens.output} out`,
    budget,
  ].join(" · ");
}

/**
 * Prints what each reading did. A session that waits for the budget is told once until a reading
 * goes through again: every waiting session looks again twice an hour, and the line would repeat.
 */
function tellDigests(io: Io): (report: DigestReport) => void {
  let waiting = false;
  return (report) => {
    if (report.waited && waiting) return;
    waiting = report.waited;
    io.out(digestLine(report));
  };
}

/** A started server: what to print, and how to stop it. */
export interface Serving {
  readonly report: Report;
  close(): Promise<void>;
}

/** The embedder, when the model directory verifies; otherwise null and the line that says why. */
async function openModel(
  io: Io,
  home: Home,
): Promise<{ embedder: LocalEmbedder | null; line: string }> {
  const embedder = openLocalEmbedder(home.modelDir);
  // The model's files are read once here; loading relies on the same answer.
  const check = await embedder.check();
  if (!check.ok) {
    await embedder.close();
    // A person may have left the model out on purpose (`ukt setup --no-model`): that is no fault.
    const why =
      check.reason === "not_installed"
        ? "none installed, so search matches words only. `ukt setup` adds it"
        : check.reason === "changed"
          ? `not usable (${check.detail}), so search matches words only. Run \`ukt doctor\``
          : `none (${check.detail}), so search matches words only`;
    return { embedder: null, line: `model: ${why}.` };
  }
  // The model loads while the server starts; a text that arrives first waits for it.
  embedder.load().catch((error: unknown) => {
    io.err(`The embedding model did not load: ${describe(error)}`);
    io.err("Search matches words only until this is fixed. Next: run `ukt doctor`.");
  });
  return { embedder, line: `model: ${check.model}` };
}

/** A number an option must be, or the failure that says what it may be. */
export function numberOf(text: string, option: string, least: number, most: number): number {
  const value = Number(text);
  if (text.trim() !== "" && Number.isInteger(value) && value >= least && value <= most)
    return value;
  throw new CliFailure({
    what: `"${text}" is not a value ${option} takes.`,
    meaning: "Nothing was started or changed.",
    next: `Pass a whole number from ${least} to ${most}.`,
  });
}

/** How long a task's lease lasts, from the minutes a person typed; undefined where they said nothing. */
export function leaseMs(minutes: string | undefined): number | undefined {
  return minutes === undefined
    ? undefined
    : numberOf(minutes, "--task-lease-minutes", 1, 1440) * 60_000;
}

const DID_NOT_START = "The server did not start.";

/**
 * The refusal of a second server on a data directory. Someone whose server runs as their service
 * and who starts one by hand is told that is what answers, and how to stop it.
 */
async function alreadyServed(
  io: Io,
  env: NodeJS.ProcessEnv,
  home: Home,
  url: string,
): Promise<CliFailure> {
  const state = await serviceState(io, env);
  const service = state.manager && serves(state, home) && state.running;
  return new CliFailure({
    what: `A server is already running on ${home.dataDir} (at ${url}).`,
    meaning: service
      ? `It runs as your service (${UNIT}), which \`ukt setup\` installed: it starts when you log in and is started again if it stops. Two servers on one store would lose writes, so this one did not start.`
      : "Two servers on one store would lose writes, so this one did not start.",
    next: service
      ? `Use the running server. To run one by hand instead, stop the service first: ${SERVICE_COMMANDS.stop}`
      : "Use the running server, or stop it first.",
  });
}

/** A start that failed for a reason the person can act on, in the three parts; anything else as it came. */
function startFailure(error: unknown, home: Home, listen: string): unknown {
  if (!(error instanceof Error)) return error;
  if ("code" in error && error.code === "EADDRINUSE")
    return new CliFailure({
      what: `${listen} is already in use.`,
      meaning: "Another program is listening there, so this server did not start.",
      next: "Stop the other program, or choose another port with --port or UKT_PORT.",
    });
  if (error instanceof RevokedTokenError)
    return new CliFailure({
      what: error.message,
      meaning: DID_NOT_START,
      next:
        home.givenToken === undefined
          ? "Run `ukt token --rotate`, then start the server again."
          : `${TOKEN_ENV} in this shell holds the revoked token. Set it to the current one (\`ukt token\` prints it) or unset it, then start the server again.`,
    });
  return storeFailure(error, DID_NOT_START) ?? error;
}

/** Where the store is, in a line that never shows a database's password. */
function storeLine(home: Home, store: HostStore): string {
  return store.kind === "embedded"
    ? `data directory: ${home.dataDir}`
    : `store: ${storePlace(home, store)} · data directory: ${home.dataDir}`;
}

/**
 * Where other machines reach a server that listens beyond this one: under each name it was told
 * it is reached by, since it refuses a request under any other. One that listens on every address
 * and was told no name answers this machine alone, which the line says.
 */
function sharedLines(told: Told & { readonly host: string }, port: number): string[] {
  const names = told.allowedHost ?? [];
  if (names.length === 0)
    return loopbackOfEvery(told.host) === null
      ? []
      : [
          "other machines: none can reach it yet, because it answers only to names it is told.",
          "  Start it with the name they will use: --allowed-host <name>",
        ];
  return names.map(
    (name) =>
      `other machines: http://${name.includes(":") ? `[${name}]` : name}:${port}/mcp, or the address of a proxy in front of it`,
  );
}

/**
 * Who must send a token. A server that only this machine reaches takes its one person's harnesses
 * by its address alone; the line says what ends that, since a harness added that way is refused
 * from then on.
 */
function tokenNeedLine(told: Told, beyond: boolean): string {
  if (told.requireToken === true) return "harnesses: each sends a token (--require-token).";
  return beyond
    ? "harnesses: each sends a token, because this server listens beyond this machine."
    : "harnesses: on this machine they need no token while you are this server's only person. Behind a proxy or a tunnel, start it with --require-token.";
}

function tokenLine(home: Home, onFile: boolean): string {
  if (onFile) return `token: ${home.tokenFile} (print it with \`ukt token\`)`;
  return home.givenToken === undefined
    ? "token: none is on file. Stop the server and run `ukt token --rotate` to make one."
    : `token: taken from ${TOKEN_ENV}`;
}

/** Starts the server. The data directory, the store and the token are made if `ukt setup` has not made them. */
export async function serve(
  io: Io,
  options: ServeOptions,
  env: NodeJS.ProcessEnv,
): Promise<Serving> {
  const home = resolveHome(options.dataDir, env);
  const told = await servingOf(home, options);
  const port = numberOf(told.port, "--port", 0, 65535);
  const taskLeaseMs = leaseMs(told.taskLeaseMinutes);
  const llm = await hostModel(home, options, env);
  const store = await hostStore(home, options.databaseUrl);
  const other = await servingNow(home);
  if (other !== null) throw await alreadyServed(io, env, home, other.url);
  await ensureDataDir(home);
  const onFile = await readTokenFile(home);
  // A token in the environment is the one to accept; else the data directory's own.
  const held = home.givenToken ?? onFile;
  const model = await openModel(io, home);
  const { embedder } = model;
  const server = await startLocalServer({
    ...storeOptions(home, store),
    host: told.host,
    port,
    embedder,
    allowedHosts: told.allowedHost,
    // With no token on file the first start issues one, and it is kept for the other verbs.
    token: held ?? undefined,
    hostKey: await ensureHostKey(home),
    taskLeaseMs,
    requireToken: told.requireToken,
    ...(llm === null ? {} : { model: llm, onDigest: tellDigests(io) }),
  }).catch(async (error: unknown) => {
    await embedder?.close();
    throw startFailure(error, home, `Port ${port} on ${told.host}`);
  });
  await rememberStore(home, store);
  if (server.issuedToken !== null) await writeToken(home, server.issuedToken);
  // The server names the address it is reached at; the other verbs and the person use that one.
  await writeRecord(home, { url: server.url });
  return {
    report: {
      data: {
        url: server.url,
        mcp_url: `${server.url}/mcp`,
        data_dir: home.dataDir,
        model: embedder === null ? null : CATALOG.embedModel,
        llm: llm === null ? null : modelName(llm),
      },
      lines: [
        `uketsugi is serving ${server.url}/mcp`,
        ...sharedLines(told, server.port),
        storeLine(home, store),
        tokenNeedLine(told, server.beyond),
        tokenLine(home, onFile !== null || server.issuedToken !== null),
        model.line,
        ...(llm === null
          ? []
          : [
              `language model: ${sentLine(modelName(llm))}`,
              `language model: at most ${llm.dailyTokens ?? DEFAULT_DAILY_TOKENS} tokens a day; readings wait once it is reached, and \`ukt doctor\` shows what has been used.`,
            ]),
        "Stop it with Ctrl-C.",
      ],
    },
    async close() {
      await removeRecord(home);
      await server.close();
      await embedder?.close();
    },
  };
}

/** Stops a started server on Ctrl-C or a termination signal, then ends the process. */
function closeOnSignal(serving: Serving): void {
  const stop = (): void => void serving.close().finally(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/** Adds `serve` to the program. */
export function serveVerb({ io, env, verb, run }: Program): void {
  const about =
    "a language model to read sessions once they are over, for this run: its key is read from UKT_LLM_KEY. Left out, the one `ukt setup --llm` remembered is used";
  llmOptions(
    onStore(serving(verb("serve", "run the server until it is stopped"))),
    about,
    "environment",
  ).action(async (options: ServeOptions) => {
    let started: Serving | undefined;
    await run("serve", options, async () => {
      started = await serve(io, options, env);
      return started.report;
    });
    if (started !== undefined) closeOnSignal(started);
  });
}
