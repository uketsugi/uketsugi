/**
 * The verbs of whoever runs a server that several people use: `people` (who is on it, and each
 * credential's kind, label, when it was made and when it was last used), `invite` (a person with
 * a token for their harness and a key for themselves, or one more of either) and `revoke` (end
 * one credential). Each asks the running server with the host's own secret, which is kept in the
 * data directory and given to no harness; a person's token, the operator's own included, is not
 * enough for any of them.
 */
import { TOKEN_ENV, type ApiPerson, type Invitation } from "@uketsugi/contracts";
import { resolveHome } from "./home.ts";
import type { Program } from "./program.ts";
import { CliFailure, type Report } from "./report.ts";
import { connectAsHost, invite, people, revoke } from "./server-client.ts";

interface PeopleOptions {
  readonly dataDir?: string;
  readonly json?: boolean;
}

/** An instant to the minute, in UTC; `never` for one that has not come. */
function minute(at: string | null): string {
  return at === null ? "never" : `${at.slice(0, 16).replace("T", " ")}Z`;
}

/** What each kind of credential is called where a person reads it. */
const KIND = { agent: "harness token", person: "dashboard key" } as const;

function personLines(person: ApiPerson): string[] {
  const tokens = person.tokens.map((token) => {
    const state =
      token.revoked_at === null
        ? `last used ${minute(token.last_used_at)}`
        : `revoked ${minute(token.revoked_at)}`;
    return `  ${token.id}  ${KIND[token.kind]}  "${token.label}"  made ${minute(token.created_at)}  ${state}`;
  });
  return [person.name, ...(tokens.length === 0 ? ["  no credential"] : tokens)];
}

/** `ukt people`: everyone on the server, each with their credentials. No secret is shown, only what names it. */
export async function listPeople(options: PeopleOptions, env: NodeJS.ProcessEnv): Promise<Report> {
  const listed = await people(await connectAsHost(resolveHome(options.dataDir, env)));
  const alone = listed.people.length === 1;
  return {
    data: { ...listed },
    lines: [
      ...listed.people.flatMap(personLines),
      // The first invitation also names whoever runs the server, as the others will see them.
      ...(alone
        ? [
            "Nobody else is on this server. Add a person with: ukt invite <name> --operator-name <your name>",
          ]
        : []),
    ],
  };
}

export interface InviteOptions extends PeopleOptions {
  /** What the credential is for, for example the machine it goes on. */
  readonly label?: string;
  /** The operator's own name, as others will see it: needed before the first person is added. */
  readonly operatorName?: string;
  /** For a person who is already there: one more harness token. */
  readonly token?: boolean;
  /** For a person who is already there: one more dashboard key. */
  readonly key?: boolean;
}

/** What to do with each secret, said where it is printed: the two are easy to mix up and must not be. */
function secretLines({ kind, id, secret }: Invitation["issued"][number]): string[] {
  const what =
    kind === "agent"
      ? `Harness token: it goes in their harness as its bearer token (${TOKEN_ENV}).`
      : "Dashboard key: theirs alone. It signs them in to the dashboard and must not go in a harness.";
  return [what, `  ${secret}`, `  its id is ${id}: \`ukt revoke ${id}\` ends it`];
}

/** `ukt invite <name>`: adds a person, or with `--token` or `--key` gives a person who is there one more credential. */
export async function invitePerson(
  name: string,
  options: InviteOptions,
  env: NodeJS.ProcessEnv,
): Promise<Report> {
  if (options.token === true && options.key === true)
    throw new CliFailure({
      what: "--token and --key were both given.",
      meaning: "Nothing was issued: one command issues one more credential.",
      next: "Run the command once with --token and once with --key.",
    });
  const another = options.token === true ? "agent" : options.key === true ? "person" : undefined;
  const server = await connectAsHost(resolveHome(options.dataDir, env));
  const invited = await invite(server, {
    name,
    ...(another === undefined ? {} : { another }),
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.operatorName === undefined ? {} : { operator_name: options.operatorName }),
  });
  const { person } = invited;
  // The first person added ends the time a harness on the server's own machine needed no token.
  const first = invited.added && (await people(server)).people.length === 2;
  const nowTokens = [
    "",
    "Every harness now sends a token, yours included. If you added one by the server's address",
    "alone, it is refused until you add it again with your token: `ukt token` prints it.",
  ];
  const howTo = [
    "",
    `Give ${person} both, and this server's address. They:`,
    "  1. sign in to the dashboard at the server's address with the dashboard key;",
    "  2. connect their harness with the harness token: the Connect page there shows the lines to run;",
    "  3. choose, on Projects, which projects to share. Until they do, each is private to them.",
  ];
  return {
    data: { ...invited },
    lines: [
      invited.added ? `Added ${person}.` : `Issued to ${person}, who was here already.`,
      "Each secret is shown this once.",
      ...invited.issued.flatMap(secretLines),
      ...(invited.added ? howTo : []),
      ...(first ? nowTokens : []),
    ],
  };
}

/** `ukt revoke <id>`: ends one credential. Every other one, of that person and of anyone else, goes on working. */
export async function revokeToken(
  tokenId: string,
  options: PeopleOptions,
  env: NodeJS.ProcessEnv,
): Promise<Report> {
  const done = await revoke(await connectAsHost(resolveHome(options.dataDir, env)), tokenId);
  return {
    data: { ...done },
    lines: [
      done.revoked
        ? `${done.id} no longer works. Nothing else was touched.`
        : `${done.id} was revoked already.`,
    ],
  };
}

/** Adds `people`, `invite` and `revoke` to the program. */
export function peopleVerbs({ env, verb, run }: Program): void {
  verb("people", "list everyone on this server and their credentials").action(
    (options: PeopleOptions) => run("people", options, () => listPeople(options, env)),
  );
  verb("invite", "add a person: a token for their harness and a key for their dashboard")
    .argument("<name>", "the person's name, as others see it beside what they share")
    .option("--token", "for a person who is already here: one more harness token")
    .option("--key", "for a person who is already here: one more dashboard key")
    .option("--label <label>", "what the credential is for, for example the machine it goes on")
    .option(
      "--operator-name <name>",
      "your own name, as others will see it; needed before the first person is added",
    )
    .action((name: string, options: InviteOptions) =>
      run("invite", options, () => invitePerson(name, options, env)),
    );
  verb("revoke", "end one credential; every other one goes on working")
    .argument("<id>", "a credential's id, as `ukt people` lists it")
    .action((tokenId: string, options: PeopleOptions) =>
      run("revoke", options, () => revokeToken(tokenId, options, env)),
    );
}
