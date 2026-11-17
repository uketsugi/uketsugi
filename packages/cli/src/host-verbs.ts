/** `ukt token`: prints the token a harness sends, or replaces it and ends the old ones. */
import { TOKEN_ENV } from "@uketsugi/contracts";
import { replaceTokens } from "@uketsugi/core";
import { readToken, resolveHome, writeToken } from "./home.ts";
import { hostOf, requireStore, withStore, type Host } from "./host-store.ts";
import { dirFlag, onStore, type OnStore, type Program } from "./program.ts";
import { CliFailure, confirmPlan, type Io, type Report } from "./report.ts";
import { pauseFor } from "./service.ts";

export interface TokenOptions extends OnStore {
  readonly dataDir?: string;
  readonly rotate?: boolean;
  readonly yes?: boolean;
  readonly json?: boolean;
}

/**
 * `ukt token --rotate`: ends every token of the host's own person and stores the one new token.
 * The store must be the verb's alone: a server that runs as the service is stopped for it and
 * started again, one started by hand is its person's to stop. Other people's tokens are not
 * touched: `ukt revoke` ends one of those.
 */
async function rotate(
  io: Io,
  { home, store }: Host,
  options: TokenOptions,
  env: NodeJS.ProcessEnv,
): Promise<Report> {
  requireStore(home, store, "token --rotate");
  const pause = await pauseFor(io, env, home, "token --rotate");
  await confirmPlan(
    io,
    [
      `This replaces the token in ${home.tokenFile}.`,
      "Every token of yours issued so far stops working at once.",
      ...(pause === null ? [] : [pause.line]),
      "Each harness that sends a token is refused until it is given the new token.",
    ],
    options,
  );
  const replace = (): Promise<{ token: string; revoked: number }> =>
    withStore(home, store, async (local) => {
      const made = await replaceTokens(local.ports, local.owner, "made by ukt token --rotate");
      await writeToken(home, made.token);
      return made;
    });
  const fresh = await (pause === null ? replace() : pause.around(replace));
  const dir = dirFlag(options);
  const steps = [
    ...(pause === null ? [[`Start the server again:  ukt serve${dir}`]] : []),
    [
      "Give each harness that sends a token the new token. A harness keeps the token it was given, so setting",
      `${TOKEN_ENV} is not enough. \`ukt ui${dir}\` opens the Connect page, which shows what to run`,
      "again for each harness.",
    ],
  ];
  return {
    data: { ...fresh },
    lines: [
      fresh.token,
      "Every earlier token of yours has stopped working.",
      ...(pause === null ? [] : ["The service is running again, with the new token."]),
      "Next:",
      ...steps.flatMap((step, at) =>
        step.map((line, index) => `  ${index === 0 ? `${at + 1}. ` : "   "}${line}`),
      ),
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
  if (options.rotate === true) return rotate(io, await hostOf(options, env), options, env);
  const home = resolveHome(options.dataDir, env);
  const held = await readToken(home);
  if (held === null)
    throw new CliFailure({
      what: `There is no token in ${home.tokenFile}.`,
      meaning: "No harness can be connected yet.",
      next: "Run `ukt setup`.",
    });
  return { data: { token: held }, lines: [held] };
}

/** Adds `token` to the program. */
export function hostVerbs({ io, env, verb, run }: Program): void {
  onStore(verb("token", "print the token a harness sends"))
    .option("--rotate", "replace the token; every token of yours issued so far stops working")
    .option("--yes", "do not ask before replacing")
    .action((options: TokenOptions) => run("token", options, () => token(io, options, env)));
}
