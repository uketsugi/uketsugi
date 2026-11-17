/**
 * `ukt setup`: from an installed release to a server that keeps running, in one command that can
 * be run again. In the data directory it makes what `ukt serve` needs: the store, the token, the
 * settings and the embedding model. Beyond it, it installs the server as a service of the
 * person's own, the one file it writes there, which it shows first and asks about once. It
 * touches no harness: it ends by printing the server's address and, for each harness, what to
 * type. Run again, it changes nothing that is in place and repairs what is not. `ukt uninstall`
 * undoes it.
 */
import { TOKEN_ENV, type ConnectInfo } from "@uketsugi/contracts";
import { issueToken } from "@uketsugi/core";
import { CATALOG } from "@uketsugi/embed";
import { localUrl } from "@uketsugi/server";
import {
  ensureDataDir,
  ensureHostKey,
  keepSettings,
  looseModes,
  readToken,
  readTokenFile,
  settingsWith,
  tightenModes,
  writeToken,
  type Home,
  type LooseMode,
} from "./home.ts";
import { hostOf, storePlace, withStore, type HostStore } from "./host-store.ts";
import { dirFlag, onStore, serving, servingOf, toldOf, type Program } from "./program.ts";
import { CliFailure, type Io, type Report } from "./report.ts";
import { llmOptions } from "./llm.ts";
import { leaseMs, numberOf } from "./serve.ts";
import { connectLines } from "./harness-lines.ts";
import { connect, connectInfo, projects, toolsListed, whoAnswers } from "./server-client.ts";
import {
  LEFT_OUT,
  llmPart,
  modelPart,
  RUNNING,
  servicePart,
  SKIPPED,
  type Done,
  type Part,
  type SetupOptions,
} from "./setup-parts.ts";
import { uninstallVerb } from "./uninstall.ts";

/** Label and lines as two columns: the label once, the lines under each other. A label too long for its column has a line of its own. */
function column(label: string, lines: readonly string[]): string[] {
  const under = lines.map((line, index) => `${(index === 0 ? label : "").padEnd(16)}${line}`);
  return label.length < 16 ? under : [label, ...lines.map((line) => `${" ".repeat(16)}${line}`)];
}

/**
 * Which of the parts that change something are done. The service changes a file outside the data
 * directory, so it is done only on the person's word: `--yes`, or their answer to the plan. Where
 * nobody can be asked it is left, and what set-up always did in the data directory is done.
 */
async function agreed(
  io: Io,
  options: SetupOptions,
  parts: readonly Part[],
  plan: readonly string[],
): Promise<Set<string>> {
  const pending = parts.filter((part) => part.pending);
  const all = new Set(pending.map((part) => part.id));
  if (!pending.some((part) => part.outside)) return all;
  if (options.json !== true && (options.yes === true || io.interactive))
    for (const line of plan) io.err(line);
  if (options.yes === true) return all;
  if (options.json === true || !io.interactive)
    return new Set(pending.filter((part) => !part.outside).map((part) => part.id));
  if (await io.confirm("Go ahead?")) return all;
  throw new CliFailure({
    what: "You backed out of set-up.",
    meaning: "Nothing was changed.",
    next: "Run `ukt setup` again when you want it. `ukt setup --plan` shows what it would do and changes nothing.",
  });
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

/** The commands the person types next. Only the data directory must be told again: the rest is kept in it. */
export function nextCommands(options: { readonly dataDir?: string }): {
  serve: string;
  token: string;
  ui: string;
} {
  const dir = dirFlag(options);
  return {
    serve: `ukt serve${dir}`,
    token: `export ${TOKEN_ENV}="$(ukt token${dir})"`,
    ui: `ukt ui${dir}`,
  };
}

/**
 * What is left for the person to do: start the server where no service runs it, then add it to
 * each harness. The lines for a harness are the server's own rows, so they are printed only once
 * it runs and has said what a harness of this machine must send.
 */
function nextLines(
  options: SetupOptions,
  served: "yes" | "no" | "refused",
  info: ConnectInfo | null,
): string[] {
  const next = nextCommands(options);
  return [
    "",
    ...(served === "no" ? [`Start the server:  ${next.serve}`, ""] : []),
    ...(served === "refused"
      ? []
      : info === null
        ? [`Once it runs, \`ukt doctor${dirFlag(options)}\` prints what to type for each harness.`]
        : [
            "Add the server to each harness you use, then type its command in a session:",
            ...connectLines(info, next.token).map((line) => `  ${line}`),
            "",
            "A session that is open now does not have it. Ask a new one something about the code:",
            `it searches memory first. \`${next.ui}\` opens the dashboard.`,
          ]),
    "",
    "An agent names its project by the repository's origin remote. For work in a directory",
    "without one, make a project name on the dashboard's Projects page.",
  ];
}

/** How the service stands for what the person does next: it runs, it was left for them to start, or it was tried and refused. */
function serviceStanding(service: Done): "yes" | "no" | "refused" {
  if (service.state === RUNNING) return "yes";
  return service.state === "failed" ? "refused" : "no";
}

/** Does the parts in turn: one that changes nothing always, one that changes something where it was agreed. */
async function carryOut(
  io: Io,
  options: SetupOptions,
  parts: readonly Part[],
  chosen: ReadonlySet<string>,
): Promise<Map<string, Done>> {
  const unasked = options.json === true || !io.interactive;
  const done = new Map<string, Done>();
  for (const part of parts) {
    if (part.apply === null) done.set(part.id, { lines: part.plan, state: part.state });
    else if (!part.pending || chosen.has(part.id)) done.set(part.id, await part.apply());
    else if (!part.outside) done.set(part.id, { lines: [LEFT_OUT], state: SKIPPED });
    else
      done.set(part.id, {
        lines: [
          unasked
            ? `not done: nobody was at the terminal to ask. \`ukt setup --yes${dirFlag(options)}\` does it, and \`--plan\` shows it first.`
            : "left as it is: you declined",
        ],
        state: SKIPPED,
      });
  }
  return done;
}

/**
 * Set-up's last check, which writes nothing: whether this data directory's server answers at its
 * address, proves it is that one, lists its tools as a harness here would ask and reads its store.
 * The line that says so, what the server says a harness must send, and the failure of a server
 * that runs and does not work.
 */
async function lastCheck(
  home: Home,
  origin: string,
): Promise<{ done: Done; info: ConnectInfo | null }> {
  if ((await whoAnswers(home, origin)) !== "own")
    return { done: { lines: ["not running"], state: SKIPPED }, info: null };
  try {
    const server = await connect(home);
    const info = await connectInfo(server);
    await toolsListed(server, info);
    await projects(server);
    return {
      done: {
        lines: ["answers, lists its tools as a harness sees them, and reads its store"],
        state: RUNNING,
      },
      info,
    };
  } catch (error) {
    if (!(error instanceof CliFailure)) throw error;
    const done = { lines: [`answers, but: ${error.failure.what}`], state: "failed" };
    return { done: { ...done, failure: error.failure }, info: null };
  }
}

/** The parts, each with how it stands. Nothing is changed by looking. */
async function survey(
  io: Io,
  env: NodeJS.ProcessEnv,
  home: Home,
  options: SetupOptions,
  origin: string,
): Promise<Part[]> {
  const { changed } = await settingsWith(home, toldOf(options));
  const llm = await llmPart(io, env, home, options);
  return [
    await modelPart(io, home, options.model),
    llm,
    // A service in place runs the settings and the language model it started with.
    await servicePart(io, env, home, options, origin, changed || llm.pending),
  ];
}

/** What set-up does about a data directory or secret file that other accounts can reach: before it is done, and after. */
function modeLines(loose: readonly LooseMode[], done: boolean): string[] {
  return loose.map(({ path, mode, allowed }) =>
    done
      ? `${path} had mode ${mode}: now ${allowed}`
      : `${path} has mode ${mode}, so other accounts can read it. Set-up runs: chmod ${allowed} ${path}`,
  );
}

/** `ukt setup`. */
export async function setup(
  io: Io,
  options: SetupOptions,
  env: NodeJS.ProcessEnv,
): Promise<Report> {
  const { home, store } = await hostOf(options, env);
  const runs = await servingOf(home, toldOf(options));
  const origin = localUrl(runs.host, numberOf(runs.port, "--port", 0, 65535));
  // A lease that `ukt serve` would refuse is refused here, before it is kept.
  leaseMs(runs.taskLeaseMinutes);
  const parts = await survey(io, env, home, options, origin);
  const heading = [`data directory  ${home.dataDir}`, `server URL      ${origin}/mcp`];
  const loose = await looseModes(home);
  const plan = [
    ...heading,
    ...modeLines(loose, false),
    ...parts.flatMap((part) => column(part.label, part.plan)),
  ];
  if (options.plan === true)
    return { data: { data_dir: home.dataDir, mcp_url: `${origin}/mcp`, plan }, lines: plan };
  const chosen = await agreed(io, options, parts, plan);

  const madeDir = await ensureDataDir(home);
  const tightened = await tightenModes(home);
  // What was told is kept only where the service can run on it: a refused port is not kept.
  const refused = parts.some((part) => part.blocked && chosen.has(part.id));
  if (!refused) await keepSettings(home, toldOf(options));
  const madeToken = await ensureStoreAndToken(home, store);
  await ensureHostKey(home);
  const done = await carryOut(io, options, parts, chosen);
  const ended = (id: string): Done => done.get(id) ?? { lines: [], state: SKIPPED };
  const { done: checked, info } = await lastCheck(home, origin);
  const onFile = (await readTokenFile(home)) !== null;
  const tokenText = onFile
    ? `${home.tokenFile}${madeToken ? " (created)" : ""}`
    : `taken from ${TOKEN_ENV}`;
  const outside = parts.filter((part) => part.outside);
  return {
    data: {
      data_dir: home.dataDir,
      store: store.kind === "postgres" ? { kind: store.kind, database: store.name } : store,
      created: { data_dir: madeDir, token: madeToken },
      token_file: onFile ? home.tokenFile : null,
      model: { state: ended("model").state, id: CATALOG.embedModel, dir: home.modelDir },
      mcp_url: `${origin}/mcp`,
      needs_token: info?.needs_token ?? null,
      harnesses:
        info?.harnesses.map(({ id, add, setup, activate }) => ({ id, add, setup, activate })) ?? [],
      parts: outside.map(({ id }) => ({ id, state: ended(id).state, lines: ended(id).lines })),
    },
    lines: [
      `data directory  ${home.dataDir}${madeDir ? " (created)" : ""}`,
      ...modeLines(tightened, true),
      ...(store.kind === "postgres" ? [`store           ${storePlace(home, store)}`] : []),
      `token           ${tokenText}`,
      ...column("model", ended("model").lines),
      ...column("language model", ended("llm").lines),
      `server URL      ${origin}/mcp`,
      ...outside.flatMap((part) => column(part.label, ended(part.id).lines)),
      ...column("server", checked.lines),
      ...nextLines(options, serviceStanding(ended("service")), info),
    ],
    failure: [...parts.map((part) => ended(part.id).failure), checked.failure].find(
      (failure) => failure !== undefined,
    ),
  };
}

/** Adds `setup` and `uninstall` to the program. */
export function setupVerbs(program: Program): void {
  const { io, env, verb, run } = program;
  const llmAbout =
    "remember a language model to read sessions once they are over, with its key, which is read from UKT_LLM_KEY or asked for; `none` forgets it";
  const about =
    "make the data directory, the store and the token, install the model and run the server as your service";
  llmOptions(onStore(serving(verb("setup", about))), llmAbout, "flag")
    .option("--no-model", "leave the embedding model out; search then matches words only")
    .option("--no-service", "do not install the service; the server runs while `ukt serve` does")
    .option("--plan", "print what set-up would do and change nothing")
    .option("--yes", "do everything in the plan without asking")
    .action((options: SetupOptions) => run("setup", options, () => setup(io, options, env)));
  uninstallVerb(program);
}
