/**
 * How a server is set to run: one table, from which the settings' type, the options that carry
 * them, the reading and writing of the file that keeps them and the order of precedence are all
 * derived. A setting is added here and nowhere else.
 */
import { DEFAULT_HOST, DEFAULT_PORT } from "@uketsugi/server";

/** How a setting's value is held: text as typed, a list of names, or a flag that is on or absent. */
interface Kinds {
  readonly text: string;
  readonly names: readonly string[];
  readonly flag: boolean;
}

interface Setting {
  readonly kind: keyof Kinds;
  /** The option as commander is given it, for example `--port <port>`. */
  readonly option: string;
  readonly about: string;
  readonly env: string;
  /** What is built in; none where the server has no need of one here. */
  readonly fallback?: string;
}

/** The settings but for where the store is, which is named once (`host-store.ts`). */
export const SERVING = {
  host: {
    kind: "text",
    option: "--host <host>",
    about: "the address to listen on",
    env: "UKT_HOST",
    fallback: DEFAULT_HOST,
  },
  port: {
    kind: "text",
    option: "--port <port>",
    about: "the port to listen on",
    env: "UKT_PORT",
    fallback: String(DEFAULT_PORT),
  },
  allowedHost: {
    kind: "names",
    option: "--allowed-host <name...>",
    about: "a name the server is reached by, besides localhost",
    env: "UKT_ALLOWED_HOSTS",
  },
  taskLeaseMinutes: {
    kind: "text",
    option: "--task-lease-minutes <minutes>",
    about: "how long a claimed task is held",
    env: "UKT_TASK_LEASE_MINUTES",
  },
  requireToken: {
    kind: "flag",
    option: "--require-token",
    about: "take no harness without a token, this machine's own included",
    env: "UKT_REQUIRE_TOKEN",
  },
} as const satisfies Record<string, Setting>;

export type ServingKey = keyof typeof SERVING;
export const SERVING_KEYS = Object.keys(SERVING) as ServingKey[];

/** How the server runs, as far as it was said: every key may be missing. */
export type Serving = { readonly [K in ServingKey]?: Kinds[(typeof SERVING)[K]["kind"]] };
