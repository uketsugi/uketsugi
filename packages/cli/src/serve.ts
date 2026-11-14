/** `ukt serve`: the server on this machine's data directory, until it is told to stop. */
import { TOKEN_ENV } from "@uketsugi/contracts";
import { RevokedTokenError } from "@uketsugi/core";
import { CATALOG, openLocalEmbedder, type LocalEmbedder } from "@uketsugi/embed";
import { loopbackOfEvery, startLocalServer } from "@uketsugi/server";
import { Option } from "commander";
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
import { listening, onStore, type Listen, type OnStore, type Program } from "./program.ts";
import { CliFailure, describe, type Io, type Report } from "./report.ts";
import { servingNow } from "./server-client.ts";

export interface ServeOptions extends Listen, OnStore {
  readonly dataDir?: string;
  /** Names the server is reached by besides the loopback ones: `--allowed-host`, or `UKT_ALLOWED_HOSTS` with commas. */
  readonly allowedHost?: readonly string[];
  /** How long a task's lease lasts, in minutes: `--task-lease-minutes` or `UKT_TASK_LEASE_MINUTES`. */
  readonly taskLeaseMinutes?: string;
  readonly json?: boolean;
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

const DID_NOT_START = "The server did not start.";

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
function sharedLines(options: ServeOptions, port: number): string[] {
  const names = options.allowedHost ?? [];
  if (names.length === 0)
    return loopbackOfEvery(options.host) === null
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
  const port = numberOf(options.port, "--port", 0, 65535);
  const { taskLeaseMinutes: minutes } = options;
  const taskLeaseMs =
    minutes === undefined ? undefined : numberOf(minutes, "--task-lease-minutes", 1, 1440) * 60_000;
  const store = await hostStore(home, options.databaseUrl);
  const other = await servingNow(home);
  if (other !== null)
    throw new CliFailure({
      what: `A server is already running on ${home.dataDir} (at ${other.url}).`,
      meaning: "Two servers on one store would lose writes, so this one did not start.",
      next: "Use the running server, or stop it first.",
    });
  await ensureDataDir(home);
  const onFile = await readTokenFile(home);
  // A token in the environment is the one to accept; else the data directory's own.
  const held = home.givenToken ?? onFile;
  const model = await openModel(io, home);
  const { embedder } = model;
  const server = await startLocalServer({
    ...storeOptions(home, store),
    host: options.host,
    port,
    embedder,
    allowedHosts: options.allowedHost,
    // With no token on file the first start issues one, and it is kept for the other verbs.
    token: held ?? undefined,
    hostKey: await ensureHostKey(home),
    taskLeaseMs,
  }).catch(async (error: unknown) => {
    await embedder?.close();
    throw startFailure(error, home, `Port ${port} on ${options.host}`);
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
      },
      lines: [
        `uketsugi is serving ${server.url}/mcp`,
        ...sharedLines(options, server.port),
        storeLine(home, store),
        tokenLine(home, onFile !== null || server.issuedToken !== null),
        model.line,
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
  const hosts = new Option(
    "--allowed-host <name...>",
    "a name the server is reached by, besides localhost",
  )
    .env("UKT_ALLOWED_HOSTS")
    .argParser((value: string, earlier: string[] = []) => [
      ...earlier,
      ...value.split(",").filter((name) => name.trim() !== ""),
    ]);
  const lease = new Option("--task-lease-minutes <minutes>", "how long a claimed task is held").env(
    "UKT_TASK_LEASE_MINUTES",
  );
  onStore(listening(verb("serve", "run the server until it is stopped")))
    .addOption(hosts)
    .addOption(lease)
    .action(async (options: ServeOptions) => {
      let serving: Serving | undefined;
      await run("serve", options, async () => {
        serving = await serve(io, options, env);
        return serving.report;
      });
      if (serving !== undefined) closeOnSignal(serving);
    });
}
