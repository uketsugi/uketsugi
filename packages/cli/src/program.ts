/** What a file of verbs is handed to add its verbs to `ukt`, and the options several verbs share. */
import { DEFAULT_HOST, DEFAULT_PORT, word } from "@uketsugi/server";
import { Option, type Command } from "commander";
import { readSettings, type Home, type Settings } from "./home.ts";
import type { Io, Report } from "./report.ts";

export interface Program {
  readonly io: Io;
  readonly env: NodeJS.ProcessEnv;
  /** A new verb of `ukt` with the options every verb takes: `--data-dir` and `--json`. */
  readonly verb: (name: string, description: string) => Command;
  /** Runs a verb's work, prints its outcome and keeps its exit code. */
  readonly run: (
    command: string,
    options: { readonly json?: boolean },
    work: () => Promise<Report>,
  ) => Promise<void>;
}

/**
 * How a server is told to run, by the verb that starts one and the verb that sets one up: the
 * settings but for where the store is, which is named once. None has a default here. `ukt setup`
 * keeps the ones it is given, and `ukt serve` starts with what it is told, else what was kept,
 * else what is built in (`servingOf`).
 */
export type Serving = Omit<Settings, "databaseUrl">;

export function serving(command: Command): Command {
  const names = (value: string, earlier: string[] = []): string[] => [
    ...earlier,
    ...value.split(",").filter((name) => name.trim() !== ""),
  ];
  return command
    .addOption(new Option("--host <host>", "the address to listen on").env("UKT_HOST"))
    .addOption(new Option("--port <port>", "the port to listen on").env("UKT_PORT"))
    .addOption(
      new Option("--allowed-host <name...>", "a name the server is reached by, besides localhost")
        .env("UKT_ALLOWED_HOSTS")
        .argParser(names),
    )
    .addOption(
      new Option("--task-lease-minutes <minutes>", "how long a claimed task is held").env(
        "UKT_TASK_LEASE_MINUTES",
      ),
    )
    .addOption(
      new Option(
        "--require-token",
        "take no harness without a token, this machine's own included",
      ).env("UKT_REQUIRE_TOKEN"),
    );
}

/** What a verb was told of how the server runs, and nothing else of its options. */
export function toldOf(options: Serving): Serving {
  const { host, port, allowedHost, taskLeaseMinutes, requireToken } = options;
  return { host, port, allowedHost, taskLeaseMinutes, requireToken };
}

/** How the server on a data directory runs: what the verb is told, else what set-up kept, else what is built in. */
export async function servingOf(
  home: Home,
  told: Serving,
): Promise<Serving & { readonly host: string; readonly port: string }> {
  const kept = await readSettings(home);
  return {
    host: told.host ?? kept.host ?? DEFAULT_HOST,
    port: told.port ?? kept.port ?? String(DEFAULT_PORT),
    allowedHost: told.allowedHost ?? kept.allowedHost,
    taskLeaseMinutes: told.taskLeaseMinutes ?? kept.taskLeaseMinutes,
    requireToken: told.requireToken ?? kept.requireToken,
  };
}

/** Where the host's store is, for the verbs that open it: needed once, when a host is first set up on a PostgreSQL server. */
export interface OnStore {
  readonly databaseUrl?: string;
}

export function onStore(command: Command): Command {
  return command.addOption(
    new Option(
      "--database-url <url>",
      "keep this host's store on a PostgreSQL server: postgres://user:password@host:port/database. Given once; the data directory remembers it",
    ).env("UKT_DATABASE_URL"),
  );
}

/** What a later command must be told again, as it is typed: the data directory, where this one was told it. */
export function dirFlag(options: { readonly dataDir?: string }): string {
  return options.dataDir === undefined ? "" : ` --data-dir ${word(options.dataDir)}`;
}
