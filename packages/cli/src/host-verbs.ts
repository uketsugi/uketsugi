/** `ukt token`: prints the token a harness sends, or replaces it and ends the old ones. */
import { TOKEN_ENV } from "@uketsugi/contracts";
import { replaceTokens } from "@uketsugi/core";
import { readToken, resolveHome, writeToken, type Home } from "./home.ts";
import { hostOf, requireStore, withStore, type Host } from "./host-store.ts";
import { dirFlag, onStore, type OnStore, type Program } from "./program.ts";
import { CliFailure, confirmPlan, type Io, type Report } from "./report.ts";
import {
  connectAsHost,
  projects,
  replaceToken,
  servingNow,
  type Running,
} from "./server-client.ts";

export interface TokenOptions extends OnStore {
  readonly dataDir?: string;
  readonly rotate?: boolean;
  readonly yes?: boolean;
  readonly json?: boolean;
}

/** What `token --rotate` tells the person to do next, whichever way the token was replaced. */
function rotated(
  home: Home,
  dir: string,
  fresh: { token: string; revoked: number },
  serving: boolean,
): Report {
  const steps = [
    ...(serving ? [] : [[`Start the server again:  ukt serve${dir}`]]),
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
      ...(serving ? ["The server is running, with the new token."] : []),
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

/**
 * Rotations at once each get a token of their own and the server ends all but the last. A token
 * that is already refused when it has been written to the file was ended by another rotation: say
 * so, since the file may hold it.
 */
async function stillLive(server: Running, token: string): Promise<void> {
  const refused = await projects({ ...server, token }).then(
    () => false,
    () => true,
  );
  if (refused)
    throw new CliFailure({
      what: "Another `ukt token --rotate` replaced this token while this one ran.",
      meaning: "The token this command made is no longer valid, and the token file may hold it.",
      next: "Run `ukt token --rotate` again, once, and use the token it prints.",
    });
}

/**
 * `ukt token --rotate`: ends every token of the host's own person and stores the one new token.
 * A running server does it, as the host, and goes on serving. With none running the verb opens
 * the store itself. Other people's tokens are not touched: `ukt revoke` ends one of those.
 */
async function rotate(io: Io, host: Host, options: TokenOptions): Promise<Report> {
  const { home, store } = host;
  const server = (await servingNow(home)) === null ? null : await connectAsHost(home);
  if (server === null) requireStore(home, store, "token --rotate");
  await confirmPlan(
    io,
    [
      `This replaces the token in ${home.tokenFile}.`,
      "Every token of yours issued so far stops working at once.",
      "Each harness that sends a token is refused until it is given the new token.",
    ],
    options,
  );
  const fresh =
    server === null
      ? await withStore(home, store, async (local) => replaceTokens(local.ports, local.owner))
      : await replaceToken(server);
  await writeToken(home, fresh.token);
  if (server !== null) await stillLive(server, fresh.token);
  return rotated(home, dirFlag(options), fresh, server !== null);
}

/** `ukt token`: prints the token a harness sends. With `--rotate`, replaces it and ends the old ones. */
export async function token(
  io: Io,
  options: TokenOptions,
  env: NodeJS.ProcessEnv,
): Promise<Report> {
  if (options.rotate === true) return rotate(io, await hostOf(options, env), options);
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
