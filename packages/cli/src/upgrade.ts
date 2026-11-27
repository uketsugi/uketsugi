/**
 * `ukt upgrade` and `ukt rollback`: a person's way to a newer release and back.
 *
 * `deploy/install.sh` is the one place that fetches, checks and swaps a release, since it must work
 * on a machine that has no `ukt`. It keeps the release it replaced beside the new one
 * (`<lib>.previous`) and then asks a `ukt` to settle the swap: restart the service if it is this
 * install's, wait until the right server answers, and where it does not put the old release back
 * and start that. `ukt upgrade` is the install script run from the address this release was built
 * to fetch it from. `ukt rollback` undoes an upgrade that went well: the release before, and the
 * copy of the store the migration made before it changed anything.
 */
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { restoreEmbeddedStore } from "@uketsugi/store";
import { Option } from "commander";
import {
  readUpgrade,
  removeStartFailure,
  removeUpgrade,
  resolveHome,
  writeUpgrade,
  type Home,
  type UpgradeRecord,
} from "./home.ts";
import { embeddedHostOf } from "./host-store.ts";
import { version } from "./version.ts";
import type { Program } from "./program.ts";
import { CliFailure, confirmPlan, size, type Io, type Report } from "./report.ts";
import {
  pauseFor,
  runsLauncher,
  SERVICE_COMMANDS,
  serviceState,
  type ServiceState,
  start,
  startCommand,
  UNIT,
  unitDataDir,
} from "./service.ts";
import { snapshotTo, stamp } from "./store-verbs.ts";

/** A snapshot the store keeps before a migration, named after the first migration it applied. */
const UPGRADE_SNAPSHOT = /^before-\d{4}_\w+\.tgz$/;

/** The first line of a release folder's `VERSION` file, as `ukt --version` says it; "unknown" where there is none. */
async function versionIn(dir: string): Promise<string> {
  const text = await readFile(join(dir, "VERSION"), "utf8").catch(() => "");
  return /^uketsugi (\S+)/.exec(text)?.[1] ?? "unknown";
}

/** The install this `ukt` belongs to: the folder its launcher is in the `bin` of. */
function installOf(env: NodeJS.ProcessEnv, verb: string): string {
  const launcher = env["UKT_LAUNCHER"];
  if (launcher === undefined || launcher === "")
    throw new CliFailure({
      what: `\`ukt ${verb}\` works on an installed release, and this \`ukt\` was not started from one.`,
      meaning: "Nothing was changed.",
      next: "Run it from the command the install script put in your bin folder.",
    });
  return resolve(launcher, "..", "..");
}

async function isDir(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() === true;
}

/** Puts `previous` where `lib` is, and drops what was there. Where the second step fails the first is undone. */
async function swap(lib: string, previous: string): Promise<void> {
  const aside = `${lib}.replaced`;
  await rm(aside, { recursive: true, force: true });
  await rename(lib, aside);
  try {
    await rename(previous, lib);
  } catch (error) {
    await rename(aside, lib);
    throw error;
  }
  await rm(aside, { recursive: true, force: true });
}

/** The newest snapshot of a migration made since `since`: the copy of the store from before the upgrade changed it. */
async function snapshotMadeSince(home: Home, since: Date): Promise<string | null> {
  const names = (await readdir(home.backupsDir).catch(() => [])).filter((name) =>
    UPGRADE_SNAPSHOT.test(name),
  );
  const made = await Promise.all(
    names.map(async (name) => ({
      file: join(home.backupsDir, name),
      at: (await stat(join(home.backupsDir, name))).mtimeMs,
    })),
  );
  return (
    made.filter(({ at }) => at >= since.getTime()).sort((a, b) => b.at - a.at)[0]?.file ?? null
  );
}

/**
 * The copy of the store the migration of an upgrade made before it changed anything: what `settle`
 * saw, else what a server started by hand made when it first started on the new release.
 */
export async function snapshotOf(home: Home, record: UpgradeRecord): Promise<string | null> {
  return record.snapshot ?? snapshotMadeSince(home, new Date(record.at));
}

export interface UpgradeOptions {
  readonly dataDir?: string;
  readonly json?: boolean;
  /** Where the release is served: the address the install line is served under. Left out, the one this release was built with. */
  readonly from?: string;
  readonly tarball?: string;
  readonly sha256?: string;
  /** Hidden: the install script's call, after it has swapped the release in the given folder. */
  readonly settle?: string;
}

/** Why a service was left as it was, in words, when the swap has no server of this install to restart; null where there is one. */
function notRestarted(state: ServiceState, home: Home, launcher: string): string | null {
  if (state.text === null || !runsLauncher(state, launcher))
    return "If `ukt serve` is running, stop it and start it again: it still runs the release this one replaced.";
  if (!state.manager)
    return `Your service (${UNIT}) could not be reached from this shell (${state.why}), so it still runs the release this one replaced. From a shell of your own login: ${SERVICE_COMMANDS.stop.replace("stop", "restart")}`;
  // One the manager keeps starting and that keeps failing is as good as down, and a new release is what may mend it.
  const failing = /activating|failed|auto-restart/.test(state.standing);
  if (!state.running && !failing)
    return `Your service (${UNIT}) is not running, so nothing was restarted. Start it with: ${startCommand(state, home)}`;
  return null;
}

/**
 * The install script's last step after it has put a new release in `lib`: restarts the service
 * if it is this install's and running, and waits until its server answers. Where it does not, the
 * release before is put back and started, and the failure says why. Either way what was done is
 * kept for `ukt rollback` and `ukt doctor`.
 */
export async function settle(
  io: Io,
  options: UpgradeOptions,
  env: NodeJS.ProcessEnv,
  given: string,
): Promise<Report> {
  const lib = await realpath(given);
  const previous = `${lib}.previous`;
  const [to, from] = [await versionIn(lib), await versionIn(previous)];
  const kept = (await isDir(previous)) ? previous : null;
  const launcher = join(lib, "bin", "ukt");
  const state = await serviceState(io, env);
  const home = resolveHome(unitDataDir(state) ?? options.dataDir, env);
  const at = new Date();
  const record: UpgradeRecord = { from, to, at: at.toISOString(), previous: kept, snapshot: null };
  const left = notRestarted(state, home, launcher);
  if (left !== null) {
    await writeUpgrade(home, record);
    return { data: { from, to, restarted: false }, lines: [left] };
  }
  const failed = await start(io, env, home, "restart");
  if (failed === null) {
    const snapshot = await snapshotMadeSince(home, at);
    await writeUpgrade(home, { ...record, snapshot });
    return {
      data: { from, to, restarted: true, snapshot },
      lines: [
        `uketsugi ${from} is now ${to}. Your service (${UNIT}) was restarted and answers on it.`,
        ...(snapshot === null
          ? [`The store needed no migration. \`ukt rollback\` brings back ${from}.`]
          : [
              `The store was migrated, and the copy of it from before is ${snapshot}.`,
              `\`ukt rollback\` returns to ${from} and to that copy; what is stored from now on would be lost by it.`,
            ]),
      ],
    };
  }
  throw await putBack({ io, env, home, lib, kept, from, to, why: failed, at });
}

/** The release before is put back and started after a new one did not start: the failure to give the person. */
async function putBack(back: {
  io: Io;
  env: NodeJS.ProcessEnv;
  home: Home;
  lib: string;
  kept: string | null;
  from: string;
  to: string;
  why: string;
  at: Date;
}): Promise<CliFailure> {
  const { io, env, home, lib, kept, from, to, why, at } = back;
  const next = `Run \`ukt doctor\`, which shows the reason, or \`${SERVICE_COMMANDS.log}\`.`;
  if (kept === null)
    return new CliFailure({
      what: `The new release (${to}) did not start: ${why}`,
      meaning: "There is no release before it to put back.",
      next: `Install the release you had again with the install script. ${next}`,
    });
  await swap(lib, kept);
  const again = await start(io, env, home, "restart");
  await writeUpgrade(home, {
    from,
    to,
    at: at.toISOString(),
    previous: null,
    snapshot: null,
    failed: why,
  });
  if (again === null) await removeStartFailure(home);
  return new CliFailure({
    what: `The new release (${to}) did not start: ${why}`,
    meaning:
      again === null
        ? `The release you had (${from}) is back and your service answers on it. Nothing in the store was changed.`
        : `The release you had (${from}) was put back, but your service does not answer on it either: ${again}`,
    next,
  });
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** What the person is told before `ukt upgrade` does anything. */
function planOf(lib: string, url: string): string[] {
  return [
    `This fetches the install script from ${url} and runs it. It then:`,
    `  - checks the release's SHA-256 and unpacks it beside ${lib};`,
    `  - replaces ${lib} with it and keeps the release you have at ${lib}.previous;`,
    `  - restarts your service (${UNIT}) if it is this install's and running, and waits until the new server answers;`,
    "  - if it does not answer, puts the release you had back, starts it, and says why.",
  ];
}

/** `ukt upgrade`: runs the install script this release was built to fetch it from, over this install. */
export async function upgrade(
  io: Io,
  options: UpgradeOptions,
  env: NodeJS.ProcessEnv,
): Promise<Report> {
  if (options.settle !== undefined) return settle(io, options, env, options.settle);
  const lib = installOf(env, "upgrade");
  const built = (await readFile(join(lib, "INSTALL_URL"), "utf8").catch(() => "")).trim();
  const served = (options.from ?? built).replace(/\/+$/, "");
  if (served === "")
    throw new CliFailure({
      what: "This release was built without the address its newer releases are served under.",
      meaning: "`ukt upgrade` has nowhere to fetch the install script from. Nothing was changed.",
      next: "Run the install line again, or name the address: ukt upgrade --from <address>.",
    });
  const url = `${served}/install.sh`;
  for (const line of planOf(lib, url)) io.out(line);
  const script = await fetchText(url).catch((error: unknown) => {
    throw new CliFailure({
      what: `The install script could not be fetched from ${url}: ${error instanceof Error ? error.message : String(error)}`,
      meaning: "Nothing was changed.",
      next: "Check the address and the network, then run it again.",
    });
  });
  const dir = await mkdtemp(join(tmpdir(), "ukt-upgrade-"));
  try {
    const file = join(dir, "install.sh");
    await writeFile(file, script, { mode: 0o600 });
    const args = [
      ...(options.tarball === undefined ? [] : ["--tarball", options.tarball]),
      ...(options.sha256 === undefined ? [] : ["--sha256", options.sha256]),
    ];
    const code = await new Promise<number>((done) => {
      const child = spawn("sh", [file, ...args], {
        stdio: "inherit",
        env: { ...env, UKT_LIB_DIR: lib },
      });
      child.on("close", (status) => done(status ?? 1));
      child.on("error", () => done(1));
    });
    if (code !== 0)
      throw new CliFailure({
        what: "The upgrade did not finish.",
        meaning:
          "What the install script said above is why. The release you had is the one that runs.",
        next: "Run `ukt doctor` to see how this install stands.",
      });
    return { data: { from: version(env), url }, lines: [] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface RollbackOptions {
  readonly dataDir?: string;
  readonly yes?: boolean;
  readonly json?: boolean;
}

/** `ukt rollback`: the release before the last upgrade and, where it migrated the store, the store as it was before. */
export async function rollback(
  io: Io,
  options: RollbackOptions,
  env: NodeJS.ProcessEnv,
): Promise<Report> {
  const lib = installOf(env, "rollback");
  const { home } = await embeddedHostOf(options, env, "rollback");
  const [previous, record] = [`${lib}.previous`, await readUpgrade(home)];
  if (!(await isDir(previous)) || record === null || record.previous === null)
    throw new CliFailure({
      what: "There is no upgrade to go back from.",
      meaning: `${previous} is not there, or the last upgrade did not leave a release behind. Nothing was changed.`,
      next: "To return to an earlier release, install it again with the install script; `ukt restore` puts back a snapshot.",
    });
  // A server started by hand migrates at its first start after the upgrade, which `settle` did not see.
  const snapshot = await snapshotOf(home, record);
  const found = snapshot === null ? null : await stat(snapshot).catch(() => null);
  if (snapshot !== null && found === null)
    throw new CliFailure({
      what: `The copy of the store from before the upgrade, ${snapshot}, is gone.`,
      meaning: `Going back would leave ${record.from} on a store it may not read. Nothing was changed.`,
      next: "Put the file back, or restore another snapshot with `ukt restore <file>` and install the release you want.",
    });
  const pause = await pauseFor(io, env, home, "rollback");
  const kept = join(home.backupsDir, `before-rollback-${stamp(new Date())}.tgz`);
  await confirmPlan(
    io,
    [
      `This puts back ${record.from}, the release before the upgrade to ${record.to} on ${record.at}.`,
      ...(snapshot === null || found === null
        ? ["The upgrade did not migrate the store, so the store is not touched."]
        : [
            `The store goes back to ${snapshot} (${size(found.size)}, made ${found.mtime.toISOString()}, before the migration).`,
            `Everything stored after that is lost from the store, and kept in ${kept}.`,
            "People, their tokens and their choices go back to what they were then.",
          ]),
      ...(pause === null ? [] : [pause.line]),
    ],
    options,
  );
  const work = async (): Promise<void> => {
    if (snapshot !== null) {
      await snapshotTo(home, kept);
      await restoreEmbeddedStore({
        dataDir: home.dataDir,
        file: snapshot,
        keepSchema: true,
      });
    }
    await swap(lib, previous);
    await removeUpgrade(home);
  };
  await (pause === null ? work() : pause.around(work));
  return {
    data: {
      from: record.to,
      to: record.from,
      snapshot,
      kept: snapshot === null ? null : kept,
    },
    lines: [
      `Back on ${record.from}.${snapshot === null ? "" : ` The store is as ${snapshot} had it; the store as it was is kept at ${kept}.`}`,
      pause === null
        ? "Start the server again with: ukt serve"
        : "The service is running again, on that release.",
    ],
  };
}

/** Adds `upgrade` and `rollback` to the program. */
export function upgradeVerbs({ io, env, verb, run }: Program): void {
  verb("upgrade", "fetch the newest release and put it in place, with a way back")
    .option(
      "--from <address>",
      "where the release is served, when it is not where this one was built to look",
    )
    .option(
      "--tarball <file or URL>",
      "install this release file instead of the one the script names",
    )
    .option("--sha256 <hex>", "the SHA-256 the release file must have")
    .addOption(new Option("--settle <folder>").hideHelp())
    .action((options: UpgradeOptions) => run("upgrade", options, () => upgrade(io, options, env)));
  verb("rollback", "go back to the release before the last upgrade, and the store it had")
    .option("--yes", "do not ask before going back")
    .action((options: RollbackOptions) =>
      run("rollback", options, () => rollback(io, options, env)),
    );
}
