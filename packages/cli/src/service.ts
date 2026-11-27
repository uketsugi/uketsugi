/**
 * The server as a service of its person's own: a unit of their systemd user manager that runs
 * `ukt serve` on one data directory, starts it when they log in and starts it again if it stops.
 * `ukt setup` writes and starts it, `ukt uninstall` takes it away, and the verbs that need the
 * store to themselves stop it for their work. The unit holds no secret and one setting, the data
 * directory: everything else `ukt serve` reads there (`Settings`), so no upgrade rewrites the unit.
 */
import { mkdir, readFile, rm, rmdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { readRecord, readStartFailure, type Home } from "./home.ts";
import { dirFlag } from "./program.ts";
import { CliFailure, lastLine, type Io } from "./report.ts";
import { servingNow, whoAnswers } from "./server-client.ts";

const NAME = "uketsugi";
/** The unit's name. `deploy/install.sh` restarts it by this name after an upgrade. */
export const UNIT = `${NAME}.service`;

/** What a person types to stop the service, start it and read what the server printed. */
export const SERVICE_COMMANDS = {
  stop: `systemctl --user stop ${NAME}`,
  start: `systemctl --user start ${NAME}`,
  log: `journalctl --user -u ${NAME}`,
} as const;

/**
 * How long the manager lets the server take to stop, in seconds: the unit says it, and `ukt` waits
 * for a stop that long, and a little more for the manager to report what came of it.
 */
const STOP_SECONDS = 600;
const STOP_WITHIN_MS = (STOP_SECONDS + 30) * 1000;
/** The verbs of `systemctl` that stop the server, and so may take as long as a stop does. */
const STOPPING = new Set(["stop", "restart", "disable"]);

/** What clears a unit the manager stopped starting after repeated failures. */
const RESET_FAILED = `systemctl --user reset-failed ${NAME}`;

/** How many of the server's last lines a person is shown. */
const LAST_LINES = 8;

/** How long a server the manager has just started may take to answer. */
const ANSWERS_WITHIN_MS = 30_000;

/**
 * The command this `ukt` was started by, which is what the service runs: the release's own
 * launcher, which tells of itself (`deploy/ukt`) and stays where it is from one release to the
 * next; run from source, this Node with this file.
 */
export function ownCommand(env: NodeJS.ProcessEnv): readonly string[] {
  const launcher = env["UKT_LAUNCHER"];
  if (launcher !== undefined && launcher !== "") return [launcher];
  return [process.execPath, ...process.execArgv, ...process.argv.slice(1, 2)];
}

/** A word of a unit's command line as systemd reads it back: quoted where it would be split, with `%` and `$` kept literal. */
function unitWord(text: string): string {
  const literal = text
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$");
  return /[\s"'\\;]/.test(text) ? `"${literal}"` : literal;
}

/** The end of the unit's command line: which data directory it serves. */
const servedBy = (home: Home): string => ` --data-dir ${unitWord(home.dataDir)}`;

/**
 * The unit: `command serve` on one data directory, named in full because a service does not have
 * its person's shell and would work the default out differently where the shell sets
 * `XDG_DATA_HOME`. A server that ends in a failure is started again, up to five times in five
 * minutes; one that is stopped stays so.
 */
export function unitText(command: readonly string[], home: Home): string {
  return [
    "# Written by `ukt setup`, which writes it again where it differs. `ukt uninstall` removes it.",
    "[Unit]",
    "Description=uketsugi, memory and task handoff for AI coding agents",
    "Documentation=https://github.com/uketsugi/uketsugi",
    // A server that fails five times in a row stops being started, so that a port or a store that
    // is gone does not have the manager start it every few seconds for good.
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    `ExecStart=${[...command, "serve"].map(unitWord).join(" ")}${servedBy(home)}`,
    "Restart=on-failure",
    "RestartSec=5",
    // `ukt serve` ends once its store is closed, a run of syncs that took 187 s on a disk under
    // other writes. The manager's default of 90 s would kill it mid-close, and the next start
    // would then recover a store that was cut off. Ten minutes still ends a server that hangs.
    // This covers `systemctl --user stop`, `restart` and an upgrade, and `ukt` waits as long for
    // those (`systemctl`). It does not cover the machine's shutdown or the last logout, where the
    // user manager itself is stopped after its own 120 s (`user@.service`) whatever this unit says.
    `TimeoutStopSec=${STOP_SECONDS}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** How the service stands for this account: no manager to run one, or what the manager says of the unit. */
export type ServiceState =
  | {
      readonly manager: false;
      readonly why: string;
      /** The unit as it is on disk, which a shell that cannot reach the manager can still read; null where there is none. */
      readonly text: string | null;
    }
  | {
      readonly manager: true;
      readonly unitFile: string;
      /** The unit as it is on disk; null where there is none. */
      readonly text: string | null;
      /** Whether it starts when its person logs in. */
      readonly enabled: boolean;
      /** Whether the manager has it running now. */
      readonly running: boolean;
      /** The manager's own words for how it stands, such as `failed` or `activating (auto-restart)`. */
      readonly standing: string;
    };

type Managed = Extract<ServiceState, { manager: true }>;

/** Where a person's own units are kept, as systemd works it out from their environment; null without a home. */
function unitFileOf(env: NodeJS.ProcessEnv): string | null {
  const [config, home] = [env["XDG_CONFIG_HOME"], env["HOME"]];
  if (config !== undefined && config !== "") return join(config, "systemd", "user", UNIT);
  return home === undefined || home === "" ? null : join(home, ".config", "systemd", "user", UNIT);
}

/** Asks the manager how the unit stands. It changes nothing. */
export async function serviceState(io: Io, env: NodeJS.ProcessEnv): Promise<ServiceState> {
  const unitFile = unitFileOf(env);
  if (unitFile === null)
    return { manager: false, why: "this account has no home directory", text: null };
  const text = await readFile(unitFile, "utf8").catch(() => null);
  const properties = "--property=ActiveState,SubState,UnitFileState";
  const shown = await io.run("systemctl", ["--user", "show", UNIT, properties], { env });
  if (shown === null) return { manager: false, why: "this machine has no systemd", text };
  // A shell entered with `su` or `sudo` has systemd and no way to its person's manager.
  if (shown.code !== 0)
    return {
      manager: false,
      why: "no systemd user manager answers in this shell (one entered with `su` or `sudo` cannot reach yours)",
      text,
    };
  const said = (key: string): string =>
    new RegExp(`^${key}=(.*)$`, "m").exec(shown.stdout)?.[1]?.trim() ?? "";
  return {
    manager: true,
    unitFile,
    text,
    enabled: said("UnitFileState") === "enabled",
    running: said("ActiveState") === "active",
    standing: `${said("ActiveState")} (${said("SubState")})`,
  };
}

/** Whether the unit is there and serves this data directory. */
export function serves(state: ServiceState, home: Home): boolean {
  return state.text !== null && state.text.includes(`${servedBy(home)}\n`);
}

/**
 * The data directory a unit serves, read back from its command line as `unitWord` wrote it; null
 * where the unit names none. A service names it in full, so this is the one the service holds,
 * whatever the shell asking has set.
 */
export function unitDataDir(state: ServiceState): string | null {
  const found = /--data-dir (?:"((?:[^"\\]|\\.)*)"|(\S+))\n/.exec(state.text ?? "");
  const text = found?.[1] ?? found?.[2];
  return text === undefined
    ? null
    : text.replaceAll(/\\(.)/g, "$1").replaceAll("%%", "%").replaceAll("$$", "$");
}

/** Whether the unit runs this launcher: the one an install's release has, which stays where it is from one release to the next. */
export function runsLauncher(state: ServiceState, launcher: string): boolean {
  return state.text?.includes(`ExecStart=${unitWord(launcher)} serve `) === true;
}

/** What starts the server again, given what starts it: the same words, as a restart. */
export function restartOf(start: string): string {
  return start === "ukt serve" ? "restart `ukt serve`" : start.replace(" start ", " restart ");
}

/** What starts the server of this data directory: its service where it has one, else the verb. */
export function startCommand(state: ServiceState, home: Home): string {
  if (!serves(state, home)) return "ukt serve";
  // A unit that gave up after repeated failures is cleared first, or the start does nothing.
  const gaveUp = state.manager && /failed|auto-restart/.test(state.standing);
  return gaveUp ? `${RESET_FAILED} && ${SERVICE_COMMANDS.start}` : SERVICE_COMMANDS.start;
}

/**
 * What brings a server that is down back: what `startCommand` says, except for a service that
 * will not start as it stands. One set-up turned off, or the manager gave up on, is put right
 * first: the service finding and the server finding both say so, in these words.
 */
export function startFix(service: ServiceState, home: Home): string {
  const start = startCommand(service, home);
  if (!service.manager || !serves(service, home) || service.running) return start;
  if (!service.enabled) return "put right what the service's lines say, then run `ukt setup`";
  return start.includes("reset-failed")
    ? `${start}, once what the service's lines say is put right`
    : start;
}

/** Runs `systemctl --user` commands in turn. The first that fails, in words for a person; null when all ran. */
async function systemctl(
  io: Io,
  env: NodeJS.ProcessEnv,
  ...commands: (readonly string[])[]
): Promise<string | null> {
  for (const args of commands) {
    const within = args.some((arg) => STOPPING.has(arg)) ? STOP_WITHIN_MS : undefined;
    const ran = await io.run("systemctl", ["--user", ...args], { env, within });
    if (ran === null || ran.code !== 0)
      return `\`systemctl --user ${args.join(" ")}\` failed${ran === null ? "" : `: ${lastLine(ran)}`}`;
  }
  return null;
}

/**
 * Waits for the server of a data directory to answer and prove it is that one: something else on
 * its port does not pass for it. False when it has not within the time a start may take, or the
 * manager says it is no longer running.
 */
async function answers(io: Io, env: NodeJS.ProcessEnv, home: Home): Promise<boolean> {
  const until = Date.now() + ANSWERS_WITHIN_MS;
  for (;;) {
    const record = await readRecord(home);
    if (record !== null && (await whoAnswers(home, record.url)) === "own") return true;
    // A server that has exited does not answer later: the manager no longer has it running.
    const state = await serviceState(io, env);
    if (Date.now() > until || (state.manager && !state.running)) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Why the service's server did not come up, as a person is shown it after a start that failed:
 * the reason the last start failed, which `ukt serve` keeps in the data directory, and the last
 * lines the server printed to the user journal. Where neither holds anything, which is so where
 * the account has no per-user journal, it says so and names what to run instead.
 */
export async function lastWords(io: Io, env: NodeJS.ProcessEnv, home: Home): Promise<string> {
  const failure = await readStartFailure(home);
  const asked = ["--user", "-u", NAME, "-n", "30", "--no-pager", "-o", "cat"];
  const ran = await io.run("journalctl", asked, { env });
  // The manager's own lines about the unit say it failed, not why: only the server's count.
  const own = /^(uketsugi\.service: |Started |Starting |Stopped |Stopping |Failed to start )/;
  const lines = (ran?.code === 0 ? ran.stdout : "")
    .split("\n")
    .filter((l) => l.trim() !== "" && !own.test(l));
  const said = lines.slice(-LAST_LINES).join("\n");
  const parts = [
    ...(failure === null
      ? []
      : [`The last start failed (${failure.at.toISOString()}):\n${failure.text}`]),
    ...(said === "" ? [] : [`Its last lines:\n${said}`]),
  ];
  if (parts.length > 0) return `\n${parts.join("\n")}`;
  return `\nThe journal holds nothing the server printed that this account can read. Run \`ukt serve${dirFlag(home)}\` in a terminal: it prints why.`;
}

/** Starts the unit and waits for its server. What went wrong, or null when the server answers and has proven itself. */
export async function start(
  io: Io,
  env: NodeJS.ProcessEnv,
  home: Home,
  how: "start" | "restart",
): Promise<string | null> {
  // A unit that stopped being started after repeated failures must be cleared before it is started.
  await systemctl(io, env, ["reset-failed", UNIT]);
  const failed = await systemctl(io, env, [how, UNIT]);
  if (failed !== null) return failed;
  if (await answers(io, env, home)) return null;
  return `the service was started, but its server does not answer. \`${SERVICE_COMMANDS.log}\` shows why.${await lastWords(io, env, home)}`;
}

/**
 * Writes the unit where it differs, has the manager read it and enable it, and starts the server
 * on it, or starts it again so that it runs what is now set up. What went wrong, or null. A unit
 * whose server does not come up is stopped and disabled again: left enabled, the manager would
 * start it every few seconds for good.
 */
export async function installService(
  io: Io,
  env: NodeJS.ProcessEnv,
  home: Home,
  state: Managed,
): Promise<string | null> {
  const text = unitText(ownCommand(env), home);
  if (state.text !== text) {
    await rememberMade(home, await mkdir(dirname(state.unitFile), { recursive: true }), state);
    await writeFileAtomic(state.unitFile, text, { mode: 0o644 });
  }
  const failed =
    (await systemctl(io, env, ["daemon-reload"], ["enable", UNIT])) ??
    (await start(io, env, home, "restart"));
  if (failed !== null) await systemctl(io, env, ["disable", "--now", UNIT]);
  return failed;
}

/** Where set-up notes the folders it had to make for the unit, so that uninstall removes those and no others. */
const madeFile = (home: Home): string => join(home.dataDir, "made-folders");

/** Notes the folders `mkdir` made, from the first it made down to the unit's own; it made none where it returns nothing. */
async function rememberMade(home: Home, first: string | undefined, state: Managed): Promise<void> {
  if (first === undefined) return;
  const made: string[] = [];
  for (let dir = dirname(state.unitFile); dir.length >= first.length; dir = dirname(dir))
    made.push(dir);
  await mkdir(home.dataDir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(madeFile(home), `${[...made, ...(await madeBefore(home))].join("\n")}\n`);
}

/** The folders set-up noted, deepest first. */
async function madeBefore(home: Home): Promise<string[]> {
  const text = await readFile(madeFile(home), "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "");
}

/** Stops the service, takes it out of the manager and deletes the unit. What went wrong, or null. */
export async function removeService(
  io: Io,
  env: NodeJS.ProcessEnv,
  home: Home,
  state: Managed,
): Promise<string | null> {
  const failed = await systemctl(io, env, ["disable", "--now", UNIT]);
  if (failed !== null) return failed;
  await rm(state.unitFile, { force: true });
  // What `enable` made, and the folders set-up made for the unit, once nothing else of the person's is in them.
  for (const dir of [
    join(dirname(state.unitFile), "default.target.wants"),
    ...(await madeBefore(home)),
  ])
    await rmdir(dir).catch(() => undefined);
  await rm(madeFile(home), { force: true });
  return systemctl(io, env, ["daemon-reload"]);
}

/**
 * Whether the manager keeps this account's services running while its person is logged out
 * (lingering); null where logind does not say. Without it the server stops at the last logout
 * and starts at the next login.
 */
export async function lingers(io: Io, env: NodeJS.ProcessEnv): Promise<boolean | null> {
  const asked = ["show-user", userInfo().username, "--property=Linger", "--value"];
  const ran = await io.run("loginctl", asked, { env });
  const said = ran?.code === 0 ? ran.stdout.trim() : "";
  return said === "yes" ? true : said === "no" ? false : null;
}

/** A server stopped for a verb's work: the line that says so in the verb's plan, and the work done around it. */
export interface Pause {
  readonly line: string;
  /** Stops the service, does the work, and starts the service again whether the work succeeded or not. */
  around<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * For a verb that needs the store to itself: null when no server holds it. A server that runs as
 * the service is stopped for the work and started again afterwards. One a person started by hand
 * is theirs to stop, and the verb is refused: the store's own lock would refuse it too, and this
 * says so before the verb asks anything.
 */
export async function pauseFor(
  io: Io,
  env: NodeJS.ProcessEnv,
  home: Home,
  verb: string,
): Promise<Pause | null> {
  const running = await servingNow(home);
  const state = await serviceState(io, env);
  // A service that is starting or that the manager keeps starting again is no server yet and holds
  // the store the moment it is: it is stopped for the work and started afterwards all the same.
  const restarting =
    state.manager && serves(state, home) && /activating|failed|auto-restart/.test(state.standing);
  if (running === null && !restarting) return null;
  const alone = `Only one process may hold the store, so \`ukt ${verb}\` did nothing.`;
  const what =
    running === null
      ? `The server of your service (${UNIT}) is not up and the manager keeps starting it.`
      : `The server is running on this data directory (at ${running.url}).`;
  // The service is there and this shell cannot reach its manager: nothing here could start it again.
  if (!state.manager && serves(state, home))
    throw new CliFailure({
      what,
      meaning: `It runs as your service (${UNIT}), and ${state.why}. ${alone}`,
      next: `Run \`ukt ${verb}\` from a shell of your own login, where \`${SERVICE_COMMANDS.stop}\` works.`,
    });
  if (!(state.manager && serves(state, home) && (state.running || restarting)))
    throw new CliFailure({
      what,
      meaning: alone,
      next: `Stop \`ukt serve\`, run \`ukt ${verb}\` again, then start the server.`,
    });
  return {
    line: `The server runs as your service (${UNIT}): it is stopped for this and started again afterwards.`,
    async around(work) {
      const stuck = await systemctl(io, env, ["stop", UNIT]);
      if (stuck !== null)
        throw new CliFailure({
          what: `The service could not be stopped: ${stuck}.`,
          meaning: alone,
          next: `Stop it with \`${SERVICE_COMMANDS.stop}\`, then run \`ukt ${verb}\` again.`,
        });
      const done = await work().catch(async (error: unknown) => {
        await start(io, env, home, "start");
        throw error;
      });
      const down = await start(io, env, home, "start");
      if (down === null) return done;
      throw new CliFailure({
        what: `\`ukt ${verb}\` did its work, but the server is not back: ${down}.`,
        meaning: "No agent reaches its memory until the server runs again.",
        next: `Start it with \`${SERVICE_COMMANDS.start}\`. \`${SERVICE_COMMANDS.log}\` shows what it printed.`,
      });
    },
  };
}
