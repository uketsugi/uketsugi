/**
 * The wiring of the server `ukt` runs: its owner, who runs it and may add other people, the system
 * clock, UUIDv7 ids, an identity that checks bearer tokens against the store, and the store
 * itself: the embedded engine in a data directory, or a PostgreSQL server when it is given one's
 * address.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acceptToken,
  createTokenIdentity,
  ensureOwner,
  issueToken,
  type AppPorts,
  type Caller,
  type Clock,
  type Embedder,
  type IdGen,
} from "@uketsugi/core";
import { openEmbeddedStore, openServerStore } from "@uketsugi/store";
import { v7 as uuidv7 } from "uuid";
import { composeServer } from "./compose.ts";
import { DEFAULT_HOST } from "./guard.ts";

/** The system's clock, in whole milliseconds. */
const systemClock: Clock = {
  now: () => new Date(),
  timeout: (ms) => AbortSignal.timeout(ms),
};

/** UUIDv7 ids and random bytes from the operating system. */
const systemIds: IdGen = {
  uuid: () => uuidv7(),
  bytes: (length) => new Uint8Array(randomBytes(length)),
};

export interface LocalPortsOptions {
  /** The data directory of the embedded store: one process owns it. Left out, the store lives in memory, as a test wants. */
  readonly dataDir?: string;
  /**
   * A PostgreSQL server to keep the store on, in place of the embedded engine:
   * `postgres://user:password@host:port/database`. The database must exist; one server process
   * serves it at a time.
   */
  readonly databaseUrl?: string;
  /** The embedding model, when one is installed. Without it search runs on the lexical passes. */
  readonly embedder?: Embedder | null;
  /** How long a task's lease lasts, in milliseconds. Left out, core's fifteen minutes. */
  readonly taskLeaseMs?: number;
}

/** The ports of the server `ukt` runs, and the owner they belong to. */
export interface LocalPorts {
  readonly ports: AppPorts;
  readonly owner: Caller;
  /** A copy of the whole store while it serves, where its host can make one: the embedded store's. */
  readonly snapshot: (() => Promise<Blob>) | null;
  close(): Promise<void>;
}

/**
 * Opens the store and the ports around it. An edition that needs another identity replaces
 * `ports.identity` and passes the rest to `composeServer` unchanged.
 */
export async function openLocalPorts(options: LocalPortsOptions): Promise<LocalPorts> {
  const { dataDir, databaseUrl, taskLeaseMs } = options;
  const embedded = databaseUrl === undefined ? await openEmbeddedStore({ dataDir }) : null;
  const store = embedded ?? (await openServerStore({ connectionString: databaseUrl ?? "" }));
  const embedder = options.embedder ?? null;
  const base = { store, clock: systemClock, ids: systemIds, embedder, taskLeaseMs };
  try {
    const owner = await ensureOwner(base);
    return {
      ports: { ...base, identity: createTokenIdentity(base) },
      owner,
      snapshot: embedded === null ? null : () => embedded.snapshot(),
      close: () => store.close(),
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}

export interface LocalServerOptions extends LocalPortsOptions {
  /** The address to listen on. Left out, this machine alone. */
  readonly host?: string;
  /** 0 takes a free port. */
  readonly port: number;
  /** A token to accept. Without one, a first start issues a token and returns it once. */
  readonly token?: string;
  /**
   * The host's own secret: what administering the server takes. Its host keeps it in the data
   * directory and gives it to no harness. Left out, the server has nobody to administer it.
   */
  readonly hostKey?: string;
  /** The folder of the dashboard's built files. Left out, the `web` package's `dist` beside this one. */
  readonly webDir?: string;
  /**
   * Other hostnames the server may be reached by, besides the loopback names and the address it
   * binds. A server bound to every address answers to the loopback names and to these.
   */
  readonly allowedHosts?: readonly string[];
}

export interface LocalServer {
  /** The base URL; `/mcp` is under it. For a server bound to every address, its loopback URL. */
  readonly url: string;
  readonly port: number;
  /** The token issued at this start, if one was; it is shown once and never stored. */
  readonly issuedToken: string | null;
  close(): Promise<void>;
}

/** Where the dashboard's built files are when this package runs from the workspace or a release. */
const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));
/** How long `git` may take to name a directory's origin. */
const GIT_ANSWER_MS = 3000;

/**
 * The origin remote of a directory on this machine, by the command the block gives an agent
 * (`git remote get-url origin`), so that both name one project. Null when the directory is not a
 * repository, has no origin, or `git` is not there.
 */
function gitOriginOf(cwd: string): Promise<string | null> {
  if (!isAbsolute(cwd)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "remote", "get-url", "origin"],
      { timeout: GIT_ANSWER_MS, windowsHide: true },
      (error, stdout) => resolve(error === null && stdout.trim() !== "" ? stdout.trim() : null),
    );
  });
}

/** Starts the whole server on a store, for its owner and whoever they add: what `ukt serve` runs. */
export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
  const local = await openLocalPorts(options);
  try {
    const { ports, owner } = local;
    let issuedToken: string | null = null;
    if (options.token !== undefined) {
      await acceptToken(ports, owner, options.token, "given at start");
    } else {
      const held = await ports.store.directory.credentials(owner.orgId, owner.principalId);
      if (!held.some((credential) => credential.revokedAt === null)) {
        issuedToken = await issueToken(ports, owner, "issued at first start");
      }
    }
    const server = composeServer({
      ports,
      allowedHosts: options.allowedHosts,
      webDir: options.webDir ?? DEFAULT_WEB_DIR,
      operator:
        options.hostKey === undefined
          ? undefined
          : {
              principalId: owner.principalId,
              key: options.hostKey,
              caller: () => ensureOwner(ports),
            },
      originOf: gitOriginOf,
      snapshot: local.snapshot ?? undefined,
    });
    const listening = await server.listen({
      host: options.host ?? DEFAULT_HOST,
      port: options.port,
    });
    return {
      url: listening.url,
      port: listening.port,
      issuedToken,
      async close() {
        await server.close();
        await local.close();
      },
    };
  } catch (error) {
    await local.close();
    throw error;
  }
}
