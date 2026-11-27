/**
 * The HTTP server and its one composition function. `composeServer` builds the whole app from
 * its ports; an edition with another identity passes its own port and reassembles nothing. This
 * package holds no business rule: every decision is core's.
 *
 * In order, a request meets: the guard (Host, Origin and fetch metadata, on every route) and the
 * response headers; then `/healthz`, `/mcp` behind a bearer token (which one person on their own
 * machine need not send, see `auth.ts`), `/sign-in` (a one-time code,
 * or the person's dashboard key), `/api`, the plugins a harness fetches (`/plugins`), and last the
 * dashboard's built files, with `index.html` for a deep link.
 */
import { existsSync } from "node:fs";
import type { Server as NodeServer } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { localhostAllowedHostnames } from "@modelcontextprotocol/server";
import { CONTRACT_VERSION, SIGN_IN_PATH } from "@uketsugi/contracts";
import {
  createApp,
  createWorker,
  ModelError,
  type AppPorts,
  type Caller,
  type ClaimedJob,
  type DigestReport,
  type ToolFailure,
} from "@uketsugi/core";
import { Hono, type Context } from "hono";
import { getPath } from "hono/utils/url";
import { bodyLimit } from "hono/body-limit";
import { checkEmbedder } from "./embedding.ts";
import { apiRoutes, body } from "./api.ts";
import { createSignIn, sentByHost, tokenAuth, type AuthEnv, type Operator } from "./auth.ts";
import { errorHandler, failed, HARNESS_REFUSALS, type HarnessRefusals } from "./errors.ts";
import {
  DEFAULT_HOST,
  fromThisMachine,
  LOOPBACK_ADDRESSES,
  loopbackOfEvery,
  requestGuard,
  responseHeaders,
} from "./guard.ts";
import { createMcpEndpoint } from "./mcp.ts";
import type { DashboardWords } from "./dashboard-words.ts";
import { createPending, type Pending, type PendingOptions } from "./pending.ts";
import { pluginRoutes, PLUGINS_PATH, pluginsFolder } from "./plugins.ts";
import { startingApp, type Starting } from "./starting.ts";
import { createToolUses } from "./tool-uses.ts";

/** What the server gives an edition's routes: what it cannot do without the server's own state. */
export interface EditionHost {
  /**
   * Signs the browser that sent this request in to the dashboard as a person the edition has
   * verified, and sets the session's cookie on the response the route then answers with.
   */
  openSession(c: Context, caller: Caller): void;
  /** A store for what the edition holds while a login is in progress, with the bound the server keeps it to. */
  pending<V>(options: PendingOptions): Pending<V>;
}

/** What differs between editions of the server: its name, its words for what it refuses, and its own routes. */
export interface Edition {
  /** The edition's name in the capability descriptor. */
  readonly name: string;
  readonly refusals: HarnessRefusals;
  /** What a dashboard key no person owns is told. Left out, the open edition's words. */
  readonly unknownKey?: () => ToolFailure;
  /** What a request nobody signed is told, the sign-in page's first answer included. Left out, the open edition's words. */
  readonly signedOut?: () => ToolFailure;
  /** What a sign-in link (`GET /sign-in?code=`) that was used or has expired is told, as text. Left out, the open edition's words. */
  readonly staleCode?: string;
  /**
   * What the dashboard tells a person of getting in and of the token. Left out, the open edition's
   * words. The set it is given says which kind of way in the edition has: the token words, or the
   * sign-in words of an edition whose harnesses sign in themselves and are given no token.
   */
  readonly dashboard?: DashboardWords;
  /**
   * The edition's own routes, built once the server's sign-in exists. They are served on the
   * server's listener behind its request guard, with its response headers, and ahead of its own
   * routes. A route that does not answer lets the request fall through to them.
   */
  readonly routes?: (host: EditionHost) => Hono;
  /**
   * Where a person joins the organization of whoever invited them: the address that carries an
   * invitation's secret. An edition that signs people in itself has it, and its dashboard offers the
   * administrator the link (`POST /api/join-links`); left out, there is no such route.
   */
  readonly joinLink?: (secret: string) => string;
  /**
   * Where a person may delete their own account (`DELETE /api/account`), what the edition says of
   * its backups beside it. Left out, the edition has no such route: the person who runs the
   * server holds the data and ends it.
   */
  readonly personalData?: { readonly backups: string };
}

/** The open edition. */
const COMMUNITY: Edition = { name: "community", refusals: HARNESS_REFUSALS };

export interface ComposeOptions {
  /** Every port the server runs on. The caller opened them and closes them. */
  readonly ports: AppPorts;
  /** Told of every error no caller could act on, a failed job among them. Defaults to standard error. */
  readonly onError?: (error: unknown) => void;
  /**
   * Other hostnames the server is reached by, without ports. It always answers to the loopback
   * names and to each address it listens on; a request under any other name is refused.
   */
  readonly allowedHosts?: readonly string[];
  /** The folder of the dashboard's built files. Left out or missing, no page is served. */
  readonly webDir?: string;
  /** The folder of the plugins harnesses install. Left out or missing, none is offered or served. */
  readonly pluginsDir?: string;
  /**
   * Whoever runs this server: the person its routes over every person's data act as (a snapshot,
   * people and their credentials, a sign-in code), and the secret those routes need. Left out,
   * nobody is.
   */
  readonly operator?: Operator;
  /** A copy of the whole store while it serves, for the operator's backup. Left out, the server offers none. */
  readonly snapshot?: () => Promise<Blob>;
  /** Told of every session the model step has read, with what the reading did and cost: counts, never text. */
  readonly onDigest?: (report: DigestReport) => void;
  /** The edition this server is. Left out, the open one. */
  readonly edition?: Edition;
}

export interface Listening {
  readonly port: number;
  /**
   * The base URL, for example `http://127.0.0.1:7410`. An IPv6 address is in brackets, and a
   * listener on every address gives its loopback URL.
   */
  readonly url: string;
  /**
   * Whether the server can now be reached from beyond its own machine: it listens on an address
   * that is not a loopback one, or answers to a name of its own. Every caller then sends a token.
   */
  readonly beyond: boolean;
  close(): Promise<void>;
}

export interface UketsugiServer {
  /** Serves one request: the whole app as a web-standard handler. */
  fetch(request: Request): Response | Promise<Response>;
  /** Listens on a host and port; port 0 takes a free one. */
  listen(options: { host?: string; port: number }): Promise<Listening>;
  /** Serves from a listener that has answered until now (`listenStarting`) and is the server's from here on. */
  takeOver(listener: StartingListener): Listening;
  /** Starts the job worker, which a listener handed over starts too. Calling it again changes nothing. */
  start(): void;
  /** Stops every listener, the worker and the MCP handler. It does not close the ports. */
  close(): Promise<void>;
}

/** An address as a URL and a Host header spell it: an IPv6 address goes in brackets. */
function hostnameOf(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

/**
 * The base URL of a server listening on `host` and `port`, as someone on this machine opens it:
 * never a wildcard address, which names no host. `ukt setup` prints it before a server runs.
 */
export function localUrl(host: string, port: number): string {
  return `http://${hostnameOf(loopbackOfEvery(host) ?? host)}:${port}`;
}

/** Answers a request; `env` is what the node server hands on of the connection it came on. */
type Handler = (request: Request, env: unknown) => Response | Promise<Response>;

/** A listener of the server's address that serves what it is given, and can be given another handler. */
interface Bound {
  readonly port: number;
  readonly url: string;
  /** The host it was asked to listen on, without brackets. */
  readonly host: string;
  /** The address it took. */
  readonly address: string;
  readonly close: () => Promise<void>;
  /** From now on this serves requests. */
  readonly serveWith: (handler: Handler) => void;
}

/** Adds the address a server listens on to the names it answers to, unless it is a loopback one. */
function nameAddress(names: Set<string>, address: string): void {
  if (loopbackOfEvery(address) === null) names.add(hostnameOf(address));
}

/** Listens on `host` and serves `first`. */
function listen(first: Handler, host: string, port: number): Promise<Bound> {
  let handler = first;
  return new Promise((resolve, reject) => {
    const fetch: Handler = (request, env) => handler(request, env);
    const server = serve({ fetch, port, hostname: host }, (info: AddressInfo) => {
      resolve({
        port: info.port,
        url: localUrl(host, info.port),
        host,
        address: info.address,
        close: () =>
          new Promise<void>((done, fail) => {
            const node = server as NodeServer;
            node.closeAllConnections();
            node.close((error) => (error === undefined ? done() : fail(error)));
          }),
        serveWith: (next) => {
          handler = next;
        },
      });
    });
    server.once("error", reject);
  });
}

/** The address a server listens on, without the brackets of an IPv6 one. */
const bareAddress = (host: string): string => host.replace(/^\[|\]$/g, "");

/** A listener that answers while the server's store is not open, and the way to hand it to the server that opens it. */
export type StartingListener = Bound;

export interface StartingOptions {
  /** The address to listen on. Left out, this machine alone. */
  readonly host?: string;
  /** 0 takes a free port. */
  readonly port: number;
  /** Other hostnames the server is reached by, as for `composeServer`. */
  readonly allowedHosts?: readonly string[];
  /** The host's own secret, for the proof that this is its server. */
  readonly hostKey?: string;
  /** What the server is doing, read on every request. */
  readonly state: () => Starting;
  readonly onError?: (error: unknown) => void;
}

/**
 * Listens and answers every request with what the server is doing until `takeOver` hands the
 * listener to the server that has opened its store. The one listener stays: nobody is refused
 * a connection at any point of the start.
 */
export async function listenStarting(options: StartingOptions): Promise<StartingListener> {
  const names = new Set([...localhostAllowedHostnames(), ...(options.allowedHosts ?? [])]);
  const onError = options.onError ?? ((error: unknown) => console.error(error));
  const app = startingApp({ names, hostKey: options.hostKey, state: options.state, onError });
  const bound = await listen(app.fetch, bareAddress(options.host ?? DEFAULT_HOST), options.port);
  nameAddress(names, bound.host);
  return bound;
}

/** Whether a request is a browser's navigation to a page, as the dashboard is opened. */
export function navigates(accept: string | undefined): boolean {
  return accept?.includes("text/html") === true;
}

/**
 * Serves the dashboard's built files. A browser's navigation to a path that is no file gets
 * `index.html`, so a deep link opens the dashboard at that page; a missing script or image stays
 * a 404. Built assets carry a hash in their names and are kept by the browser; the page itself is
 * always asked for again.
 */
function serveDashboard(http: Hono<AuthEnv>, webDir: string): void {
  http.use(
    "*",
    serveStatic({
      root: webDir,
      onFound: (path, c) => {
        const hashed = path.includes("/assets/");
        c.header("Cache-Control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
      },
    }),
  );
  const page = serveStatic({
    root: webDir,
    path: "index.html",
    onFound: (_path, c) => c.header("Cache-Control", "no-cache"),
  });
  http.get("*", (c, next) => (navigates(c.req.header("accept")) ? page(c, next) : next()));
}

/**
 * A job's failure as the log holds it: which job, on which attempt, whether it will run again, and
 * the handler's own error as its cause. A job carries ids, so no text of a fact is in it.
 */
function jobFailure(job: ClaimedJob, error: unknown, dead: boolean): Error {
  const next = dead ? "it will not be tried again" : "it will be tried again";
  const what = `The ${job.kind} job about ${job.subject} failed on attempt ${job.attempts}; ${next}`;
  // A model that answers badly is told in the reason it gave, which names no text of a session.
  return error instanceof ModelError
    ? new Error(`${what}: ${error.message}.`, { cause: error })
    : new Error(`${what}.`, { cause: error });
}

/** What the server's terminal gets of an error: a model's fault in its one line, anything else with its trace. */
function printed(error: unknown): unknown {
  return error instanceof Error && error.cause instanceof ModelError ? error.message : error;
}

/** The largest body the sign-in page may send: one key. */
const SIGN_IN_BODY_BYTES = 4096;

/** Builds the server from its ports. */
export function composeServer(options: ComposeOptions): UketsugiServer {
  const { webDir, snapshot, operator, edition = COMMUNITY } = options;
  const onError = options.onError ?? ((error: unknown) => console.error(printed(error)));
  // The outbox worker runs in this process. Its store wakes it when a unit leaves a job.
  const worker = createWorker(options.ports, {
    onFailure: (job, error, dead) => onError(jobFailure(job, error, dead)),
    onDigest: options.onDigest,
  });
  const ports = { ...options.ports, store: worker.store };
  // Asked now, so that the first question about the model is answered by what it did.
  checkEmbedder(ports.embedder);
  const app = createApp(ports, { onError });
  const toolUses = createToolUses(ports);
  const mcp = createMcpEndpoint(app, ports, toolUses, onError);
  const plugins = pluginsFolder(options.pluginsDir);
  const signIn = createSignIn(ports, app, edition);
  // An address given with a slash at its end makes `//mcp` of `/mcp`: a path is read with its
  // repeated slashes as one, so a person who types the address that way is still served.
  const http = new Hono<AuthEnv>({
    getPath: (request) => getPath(request).replace(/\/{2,}/g, "/"),
  });
  const listeners: Listening[] = [];

  http.onError(errorHandler(onError));
  const hostnames = new Set([...localhostAllowedHostnames(), ...(options.allowedHosts ?? [])]);
  http.use("*", requestGuard(hostnames));
  http.use("*", responseHeaders());

  // Anyone may ask whether the server is up. How much work waits is every person's taken
  // together, so only whoever runs the server is told.
  http.get("/healthz", async (c) => {
    const up = { status: "ok", name: "uketsugi", contractVersion: CONTRACT_VERSION };
    if (!sentByHost(c, operator)) return c.json(up);
    return c.json({ ...up, jobs: await ports.store.jobs.counts() });
  });

  if (edition.routes !== undefined) {
    const nowMs = (): number => ports.clock.now().getTime();
    http.route(
      "/",
      edition.routes({
        openSession: (c, caller) => signIn.open(c, caller),
        pending: (pendingOptions) => createPending(nowMs, pendingOptions),
      }),
    );
  }

  // A request with no token is its identity's to answer only where nothing but this machine can
  // have sent it: every listener is on a loopback address, the server answers to no name but the
  // loopback ones, and the request came straight from a local program.
  let reachable = (options.allowedHosts ?? []).length > 0;
  const alone = (c: Context): boolean => !reachable && fromThisMachine(c);

  http.use("/mcp", tokenAuth(app, alone, edition.refusals));
  http.all("/mcp", (c) => mcp.fetch(c.req.raw, c.get("caller")));
  // A harness with no token asks here to sign in with OAuth: it is told what the server takes.
  http.all("/register", (c) => failed(c, edition.refusals.register()));

  http.get(SIGN_IN_PATH, (c) => signIn.exchange(c));
  http.post(SIGN_IN_PATH, bodyLimit({ maxSize: SIGN_IN_BODY_BYTES }), body("SignInRequest"), (c) =>
    signIn.withKey(c, c.req.valid("json").key),
  );
  const api = { app, ports, edition, signIn, onError, operator, snapshot, toolUses };
  http.route("/api", apiRoutes({ ...api, plugins, alone }));
  if (plugins !== null) http.route(PLUGINS_PATH, pluginRoutes(plugins));
  if (webDir !== undefined && existsSync(webDir)) serveDashboard(http, webDir);

  const start = (): void => worker.start();
  const takeOver = (bound: StartingListener): Listening => {
    start();
    nameAddress(hostnames, bound.host);
    if (!LOOPBACK_ADDRESSES.includes(bound.address)) reachable = true;
    bound.serveWith(http.fetch);
    const { port, url, close } = bound;
    const listening = { port, url, close, beyond: reachable };
    listeners.push(listening);
    return listening;
  };

  return {
    fetch: (request) => http.fetch(request),
    takeOver,
    start,
    async listen({ host = DEFAULT_HOST, port }) {
      return takeOver(await listen(http.fetch, bareAddress(host), port));
    },
    async close() {
      await Promise.all(listeners.splice(0).map((listening) => listening.close()));
      await worker.stop();
      await mcp.close();
    },
  };
}
