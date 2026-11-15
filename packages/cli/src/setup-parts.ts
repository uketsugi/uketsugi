/**
 * What `ukt setup` does beyond the data directory's own small files, a part each: the embedding
 * model and the server as a service of the person's own. A part says how it stands or what doing
 * it would change and where, which is what the person reads before they agree, and then does it.
 * Nothing here touches a harness: a person adds the server to each one by its address.
 */
import { dirname, join } from "node:path";
import { installModel, verifyModel } from "@uketsugi/embed";
import type { Home } from "./home.ts";
import { dirFlag, type OnStore, type Serving } from "./program.ts";
import type { Failure, Io } from "./report.ts";
import { servingNow, whoAnswers } from "./server-client.ts";
import {
  installService,
  lingers,
  ownCommand,
  SERVICE_COMMANDS,
  serves,
  serviceState,
  UNIT,
  unitText,
  type ServiceState,
} from "./service.ts";

export interface SetupOptions extends Serving, OnStore {
  readonly dataDir?: string;
  /** False with `--no-model`: the model is left out and search matches words only. */
  readonly model: boolean;
  /** False with `--no-service`: the server runs while `ukt serve` does. */
  readonly service?: boolean;
  /** With `--plan`: what set-up would do is printed and nothing is changed. */
  readonly plan?: boolean;
  /** With `--yes`: everything in the plan is done and nothing is asked. */
  readonly yes?: boolean;
  readonly json?: boolean;
}

/** How one part ended: its lines, how it stands now, and the failure if it did not do what it set out to. */
export interface Done {
  readonly lines: readonly string[];
  /** A word for how it stands, which `--json` reports: `running`, `installed`, `failed`. */
  readonly state: string;
  readonly failure?: Failure;
}

/** One thing set-up does beyond the data directory's own small files. */
export interface Part {
  readonly id: string;
  readonly label: string;
  /** How it stands, or what doing it changes and where: what the person reads before they agree. */
  readonly plan: readonly string[];
  /** The word for how it stands before anything is done. */
  readonly state: string;
  /** Whether doing it changes anything. A part that changes nothing is not asked about. */
  readonly pending: boolean;
  /** Whether what it changes is outside the data directory, which a person is asked about first. */
  readonly outside: boolean;
  /** Whether it was found to be impossible as things stand, so nothing told to set-up may be kept for it. */
  readonly blocked?: boolean;
  /** Does it; null where there is nothing to do, because it is in place, left out or cannot be had here. */
  readonly apply: (() => Promise<Done>) | null;
}

const WORDS_ONLY = "search will match words only, not meaning";
export const LEFT_OUT = `left out; ${WORDS_ONLY}`;
export const STANDS = "Everything else set-up did is in place.";
/** The word for a part that was left as it is. */
export const SKIPPED = "skipped";

function modelFailure(what: string, next: string): Failure {
  return {
    what,
    meaning: `The data directory and the token are ready and \`ukt serve\` will run, but ${WORDS_ONLY}.`,
    next,
  };
}

/** Makes the model usable: verifies the directory `UKT_MODEL_DIR` names, or installs into ours. */
async function prepareModel(io: Io, home: Home): Promise<Done> {
  if (!home.modelIsOurs) {
    const check = await verifyModel(home.modelDir);
    if (check.ok)
      return { lines: [`${check.model}, verified in ${home.modelDir}`], state: "present" };
    return {
      lines: [`not usable; ${WORDS_ONLY}`],
      state: "failed",
      failure: modelFailure(
        `The model directory UKT_MODEL_DIR=${home.modelDir} cannot be used: ${check.detail}.`,
        "Point UKT_MODEL_DIR at a directory that holds the model, or unset it and run `ukt setup` again to install the model.",
      ),
    };
  }
  const progress = io.progress("Installing the embedding model (a download of about 170 MB)");
  const outcome = await installModel(home.modelDir, {
    onProgress: ({ name, received, total }) => progress.update(name, received, total),
  });
  progress.stop(outcome.ok ? "The embedding model is installed." : "The model was not installed.");
  if (outcome.ok) {
    const state = outcome.fetched ? "installed" : "present";
    return { lines: [`${outcome.model}, ${state} in ${home.modelDir}`], state };
  }
  if (outcome.reason === "unsupported_platform")
    return { lines: [`${outcome.detail}; ${WORDS_ONLY}`], state: "unsupported" };
  const failure =
    outcome.reason === "fetch_failed"
      ? modelFailure(
          `The embedding model could not be downloaded: ${outcome.detail}.`,
          "Check the network connection and run `ukt setup` again. To go without the model: `ukt setup --no-model`.",
        )
      : modelFailure(
          `A downloaded file is not the pinned one: ${outcome.detail}.`,
          "Run `ukt setup` again. If it repeats, the source is serving other files than the ones this release pins: do not use them.",
        );
  return { lines: [`not installed; ${WORDS_ONLY}`], state: "failed", failure };
}

/** The embedding model: a download into the data directory the first time, a check of its files after. */
export async function modelPart(io: Io, home: Home, wanted: boolean): Promise<Part> {
  const part = { id: "model", label: "model", outside: false, state: SKIPPED };
  if (!wanted) return { ...part, plan: [LEFT_OUT], pending: false, apply: null };
  const there = !home.modelIsOurs || (await verifyModel(home.modelDir)).ok;
  return {
    ...part,
    plan: there
      ? [`in place, in ${home.modelDir}`]
      : [
          `a download of about 170 MB into ${home.modelDir}, from the npm registry and Hugging Face,`,
          "each file checked against a pinned hash. It lets search match meaning.",
        ],
    pending: !there,
    apply: () => prepareModel(io, home),
  };
}

/** The word for a service that runs. */
export const RUNNING = "running";
const HOW_TO_RUN_IT = `stop: ${SERVICE_COMMANDS.stop} · start: ${SERVICE_COMMANDS.start} · log: ${SERVICE_COMMANDS.log}`;
const LASTING = "starts when you log in and is started again if it stops";

/** Why the service cannot be started as things stand, and what to do, or null: its port is another program's, or its store a server's started by hand. */
async function inTheWay(
  home: Home,
  origin: string,
  running: boolean,
): Promise<{ why: string; next: string } | null> {
  if ((await whoAnswers(home, origin)) === "other")
    return {
      why: `something that is not this data directory's server is listening at ${origin}`,
      next: "Choose another port: ukt setup --port <port>",
    };
  const byHand = running ? null : await servingNow(home);
  return byHand === null
    ? null
    : {
        why: `a server started by hand is serving this data directory (at ${byHand.url})`,
        next: "Stop it (Ctrl-C in its terminal), then run `ukt setup` again",
      };
}

/** What a person is told where the manager stops their services at their last logout (no lingering): the server stops with it. */
async function whenItStops(io: Io, env: NodeJS.ProcessEnv): Promise<string[]> {
  return (await lingers(io, env)) === false
    ? [
        "It stops when you log out of this machine and starts at your next login. To keep it",
        "running while you are logged out: loginctl enable-linger (set-up does not change that).",
      ]
    : [];
}

/** What a person is told where a model directory of their shell's is not the service's: the unit carries no environment. */
function modelNotice(home: Home): string[] {
  return home.modelIsOurs
    ? []
    : [
        `UKT_MODEL_DIR names ${home.modelDir}, which the service does not see: it looks in ${join(home.dataDir, "model")}.`,
        "Put the model there, or run `ukt serve` by hand with UKT_MODEL_DIR set.",
      ];
}

/** Installs the service, or reports what is in the way, in the words of a part that ended. */
async function installPart(
  io: Io,
  env: NodeJS.ProcessEnv,
  home: Home,
  options: SetupOptions,
  state: Extract<ServiceState, { manager: true }>,
  blocked: { why: string; next: string } | null,
  notes: readonly string[],
): Promise<Done> {
  const failed = blocked === null ? await installService(io, env, home, state) : null;
  if (blocked === null && failed === null)
    return {
      lines: [`${UNIT} is enabled and running: it ${LASTING}`, HOW_TO_RUN_IT, ...notes],
      state: RUNNING,
    };
  const why = blocked?.why ?? failed?.split("\n")[0] ?? "";
  const next =
    blocked?.next ??
    `Fix what it names and run \`ukt setup\` again, or start the server by hand: ukt serve${dirFlag(options)}`;
  return {
    lines: [blocked === null ? `not running: ${failed}` : `not running: ${why}. ${next}`],
    state: "failed",
    failure: {
      what: `The service was not started: ${why}${why.endsWith(".") ? "" : "."}`,
      meaning: `${STANDS} Until the server runs, no agent reaches its memory.`,
      next,
    },
  };
}

/**
 * The server as the person's own service, at `origin`. `restart` says the settings change with
 * this run, so a service that is in place must still start again to run them.
 */
export async function servicePart(
  io: Io,
  env: NodeJS.ProcessEnv,
  home: Home,
  options: SetupOptions,
  origin: string,
  restart: boolean,
): Promise<Part> {
  const part = { id: "service", label: "service", outside: true, pending: false, apply: null };
  const byHand = `The server runs while \`ukt serve${dirFlag(options)}\` does`;
  if (options.service === false) return { ...part, state: SKIPPED, plan: [`left out. ${byHand}.`] };
  const state = await serviceState(io, env);
  if (!state.manager)
    return {
      ...part,
      state: "none",
      plan: [
        `none: ${state.why}. ${byHand}:`,
        "give it a terminal of its own, or start it with whatever starts programs on this machine.",
      ],
    };
  // One unit, one data directory: a second host on this account is served by hand.
  if (state.text !== null && !serves(state, home))
    return {
      ...part,
      state: SKIPPED,
      plan: [`${UNIT} is there and serves another data directory: left as it is.`, `${byHand}.`],
    };
  const stops = await whenItStops(io, env);
  const text = unitText(ownCommand(env), home);
  if (state.text === text && state.enabled && state.running && !restart)
    return {
      ...part,
      state: RUNNING,
      plan: [`in place: ${UNIT} is enabled and running`, HOW_TO_RUN_IT, ...stops],
    };
  const change =
    state.text === null
      ? `write ${state.unitFile}, enable it (the manager adds a link to it in ${join(dirname(state.unitFile), "default.target.wants")}) and start it.`
      : state.text !== text
        ? `write ${state.unitFile} again, which runs another command, and start the server on it.`
        : `${UNIT} is ${state.running ? "running what was set up before" : `not running, ${state.standing}`}: enable it and start it again.`;
  const unit =
    state.text === text
      ? []
      : [
          "The unit:",
          ...text
            .trimEnd()
            .split("\n")
            .map((line) => `  ${line}`),
        ];
  const blocked = await inTheWay(home, origin, state.running);
  const model = modelNotice(home);
  return {
    ...part,
    state: SKIPPED,
    plan: [
      ...(blocked === null ? [] : [`not possible as things stand: ${blocked.why}.`]),
      change,
      `The server then ${LASTING}.`,
      ...stops,
      ...model,
      ...unit,
    ],
    pending: true,
    blocked: blocked !== null,
    apply: () => installPart(io, env, home, options, state, blocked, [...stops, ...model]),
  };
}
