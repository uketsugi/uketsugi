/** What a file of verbs is handed to add its verbs to `ukt`, and the options several verbs share. */
import { word } from "@uketsugi/server";
import { Option, type Command } from "commander";
import { readSettings, type Home } from "./home.ts";
import type { Io, Report } from "./report.ts";
import { SERVING, SERVING_KEYS, type Serving } from "./settings.ts";

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
 * How a server is told to run, by the verb that starts one and the verb that sets one up
 * (`settings.ts` has the table). None has a default here. `ukt setup` keeps the ones it is given,
 * and `ukt serve` starts with what it is told, else what was kept, else what is built in
 * (`servingOf`).
 */
export type { Serving };

const names = (value: string, earlier: string[] = []): string[] => [
  ...earlier,
  ...value.split(",").filter((name) => name.trim() !== ""),
];

export function serving(command: Command): Command {
  for (const key of SERVING_KEYS) {
    const { option, about, env, kind } = SERVING[key];
    const added = new Option(option, about).env(env);
    command.addOption(kind === "names" ? added.argParser(names) : added);
  }
  return command;
}

/** What a verb was told of how the server runs, and nothing else of its options. */
export function toldOf(options: Serving): Serving {
  return Object.fromEntries(SERVING_KEYS.map((key) => [key, options[key]]));
}

/** How the server on a data directory runs: what the verb is told, else what set-up kept, else what is built in. */
export async function servingOf(
  home: Home,
  told: Serving,
): Promise<Serving & { readonly host: string; readonly port: string }> {
  const kept = await readSettings(home);
  const chosen = Object.fromEntries(
    SERVING_KEYS.map((key) => {
      const { fallback } = SERVING[key] as { readonly fallback?: string };
      return [key, told[key] ?? kept[key] ?? fallback];
    }),
  );
  return chosen as Serving & { readonly host: string; readonly port: string };
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
