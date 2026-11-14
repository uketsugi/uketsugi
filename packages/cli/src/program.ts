/** What a file of verbs is handed to add its verbs to `ukt`, and the options several verbs share. */
import { DEFAULT_HOST, DEFAULT_PORT } from "@uketsugi/server";
import { Option, type Command } from "commander";
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

/** The address a server listens on, for the verbs that start one or print where it will be. */
export interface Listen {
  readonly host: string;
  readonly port: string;
}

export function listening(command: Command): Command {
  return command
    .addOption(
      new Option("--host <host>", "the address to listen on").env("UKT_HOST").default(DEFAULT_HOST),
    )
    .addOption(
      new Option("--port <port>", "the port to listen on")
        .env("UKT_PORT")
        .default(String(DEFAULT_PORT)),
    );
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
