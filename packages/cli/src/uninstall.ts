/**
 * `ukt uninstall`: undoes what `ukt setup` did outside the data directory: it stops and removes the
 * service. A harness the person added the server to is theirs: the last lines say what removes it.
 * The data directory and the release stay; its last lines say how to delete them.
 */
import { dirname } from "node:path";
import { connectInfo, word } from "@uketsugi/server";
import { resolveHome } from "./home.ts";
import type { Program } from "./program.ts";
import { confirmPlan, type Io, type Report } from "./report.ts";
import { removeService, SERVICE_COMMANDS, serves, serviceState, UNIT } from "./service.ts";

export interface UninstallOptions {
  readonly dataDir?: string;
  readonly yes?: boolean;
  readonly json?: boolean;
}

/** What is left once set-up is undone, and the line that deletes it. */
function whatIsLeft(env: NodeJS.ProcessEnv, dataDir: string): string[] {
  const launcher = env["UKT_LAUNCHER"];
  const release = launcher === undefined ? [] : [dirname(dirname(launcher))];
  return [
    "Your data and the program are as they were. To delete them as well:",
    `  rm -rf ${[dataDir, ...release].map(word).join(" ")}`,
    ...(release.length === 0
      ? []
      : [
          "and the `ukt` command the install script made: ~/.local/bin/ukt, unless it was told another place.",
        ]),
  ];
}

/** What takes the server out of each harness it was added to: the rows' own remove lines, which only the person's harness can run. */
function harnessesKeepIt(): string[] {
  const removes = connectInfo("", null, false).harnesses.flatMap(({ name, remove }) =>
    remove === undefined ? [] : [`  ${name}: ${remove}`],
  );
  return [
    "A harness you added the server to keeps it, and set-up never touched it. To take it out:",
    ...removes,
  ];
}

export async function uninstall(
  io: Io,
  options: UninstallOptions,
  env: NodeJS.ProcessEnv,
): Promise<Report> {
  const home = resolveHome(options.dataDir, env);
  const state = await serviceState(io, env);
  const service = state.manager && serves(state, home) ? state : null;
  // The unit is there and this shell cannot reach the manager that runs it: said, not passed over.
  const unreached = !state.manager && serves(state, home);
  const left = [...harnessesKeepIt(), ...whatIsLeft(env, home.dataDir)];
  if (service === null)
    return {
      data: { data_dir: home.dataDir, removed: [] },
      lines: ["Nothing to undo: no service runs this data directory.", ...left],
      ...(!unreached
        ? {}
        : {
            failure: {
              what: "The service is still there.",
              meaning: "This shell cannot reach the manager that runs it, so it was not removed.",
              next: `Run \`ukt uninstall\` from a shell of your own login, where \`${SERVICE_COMMANDS.stop}\` works.`,
            },
          }),
    };
  await confirmPlan(
    io,
    [
      "This takes uketsugi out of what `ukt setup` put it in:",
      `  the service: ${UNIT} is stopped and disabled, and ${service.unitFile} is deleted`,
      `The data directory, ${home.dataDir}, and the release are not touched.`,
    ],
    options,
  );
  const failed = await removeService(io, env, home, service);
  return {
    data: { data_dir: home.dataDir, removed: failed === null ? ["the service"] : [] },
    lines: [
      failed === null ? "removed: the service" : `not removed: the service: ${failed}`,
      ...left,
    ],
    ...(failed === null
      ? {}
      : {
          failure: {
            what: "The service could not be removed.",
            meaning: "It is as it was.",
            next: "Fix what the line above names and run `ukt uninstall` again.",
          },
        }),
  };
}

/** Adds `uninstall` to the program. */
export function uninstallVerb({ io, env, verb, run }: Program): void {
  verb("uninstall", "stop and remove the service; your data stays")
    .option("--yes", "do not ask before removing")
    .action((options: UninstallOptions) =>
      run("uninstall", options, () => uninstall(io, options, env)),
    );
}
