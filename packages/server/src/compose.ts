/**
 * The HTTP server and its one composition function. `composeServer` builds the whole app from
 * its ports; an edition with another identity passes its own port and reassembles nothing. This
 * package holds no business rule: every decision is core's.
 *
 * In order, a request meets: the guard (Host, Origin and fetch metadata, on every route) and the
 * response headers; then `/healthz`, `/mcp` behind a bearer token, `/sign-in` (a one-time code,
 * or the person's dashboard key), `/api`, and last the dashboard's built files, with `index.html`
 * for a deep link.
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
  validateRequest,
  type AppPorts,
  type ClaimedJob,
  type OriginOf,
} from "@uketsugi/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import { apiRoutes } from "./api.ts";
import { createSignIn, sentByHost, tokenAuth, type AuthEnv, type Operator } from "./auth.ts";
import { errorHandler, failed, HARNESS_REFUSALS, noOAuth } from "./errors.ts";
import { DEFAULT_HOST, loopbackOfEvery, requestGuard, responseHeaders } from "./guard.ts";
import { createMcpEndpoint } from "./mcp.ts";

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
  /**
   * Whoever runs this server: the person its routes over every person's data act as (a snapshot,
   * people and their credentials, a sign-in code), the secret those routes need, and the only
   * person whose working directory is looked up on this machine. Left out, nobody is.
   */
  readonly operator?: Operator;
  /** The origin remote of a directory on this machine, for a session's note that names only one. */
  readonly originOf?: OriginOf;
  /** A copy of the whole store while it serves, for the operator's backup. Left out, the server offers none. */
  readonly snapshot?: () => Promise<Blob>;
}

export interface Listening {
  readonly port: number;
  /**
   * The base URL, for example `http://127.0.0.1:7410`. An IPv6 address is in brackets, and a
   * listener on every address gives its loopback URL.
   */
  readonly url: string;
  close(): Promise<void>;
}

export interface UketsugiServer {
  /** Serves one request: the whole app as a web-standard handler. */
  fetch(request: Request): Response | Promise<Response>;
  /** Listens on a host and port; port 0 takes a free one. */
  listen(options: { host?: string; port: number }): Promise<Listening>;
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

function listen(fetch: UketsugiServer["fetch"], host: string, port: number): Promise<Listening> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch, port, hostname: host }, (info: AddressInfo) => {
      resolve({
        port: info.port,
        url: localUrl(host, info.port),
        close: () =>
          new Promise<void>((done, fail) => {
            const node = server as NodeServer;
            node.closeAllConnections();
            node.close((error) => (error === undefined ? done() : fail(error)));
          }),
      });
    });
    server.once("error", reject);
  });
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
  const navigates = (accept: string | undefined) => accept?.includes("text/html") === true;
  http.get("*", (c, next) => (navigates(c.req.header("accept")) ? page(c, next) : next()));
}

/**
 * A job's failure as the log holds it: which job, on which attempt, whether it will run again, and
 * the handler's own error as its cause. A job carries ids, so no text of a fact is in it.
 */
function jobFailure(job: ClaimedJob, error: unknown, dead: boolean): Error {
  const next = dead ? "it will not be tried again" : "it will be tried again";
  const what = `The ${job.kind} job about ${job.subject} failed on attempt ${job.attempts}; ${next}.`;
  return new Error(what, { cause: error });
}

/** The largest body the sign-in page may send: one key. */
const SIGN_IN_BODY_BYTES = 4096;

/** Builds the server from its ports. */
export function composeServer(options: ComposeOptions): UketsugiServer {
  const { webDir, originOf, snapshot, operator } = options;
  const onError = options.onError ?? ((error: unknown) => console.error(error));
  // The outbox worker runs in this process. Its store wakes it when a unit leaves a job.
  const worker = createWorker(options.ports, {
    onFailure: (job, error, dead) => onError(jobFailure(job, error, dead)),
  });
  const ports = { ...options.ports, store: worker.store };
  const app = createApp(ports, { onError });
  const mcp = createMcpEndpoint(app, ports, onError);
  const signIn = createSignIn(ports, app);
  const http = new Hono<AuthEnv>();
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

  http.use("/mcp", tokenAuth(app, HARNESS_REFUSALS));
  http.all("/mcp", (c) => mcp.fetch(c.req.raw, c.get("caller")));
  // A harness with no token asks here to sign in with OAuth: it is told what the server takes.
  http.all("/register", (c) => failed(c, noOAuth()));

  http.get(SIGN_IN_PATH, (c) => signIn.exchange(c));
  http.post(
    SIGN_IN_PATH,
    bodyLimit({ maxSize: SIGN_IN_BODY_BYTES }),
    validator("json", (sent) => validateRequest("SignInRequest", "body", sent)),
    (c) => signIn.withKey(c, c.req.valid("json").key),
  );
  http.route("/api", apiRoutes({ app, ports, signIn, onError, operator, originOf, snapshot }));
  if (webDir !== undefined && existsSync(webDir)) serveDashboard(http, webDir);

  return {
    fetch: (request) => http.fetch(request),
    async listen({ host = DEFAULT_HOST, port }) {
      worker.start();
      const address = host.replace(/^\[|\]$/g, "");
      const listening = await listen(http.fetch, address, port);
      if (loopbackOfEvery(address) === null) hostnames.add(hostnameOf(address));
      listeners.push(listening);
      return listening;
    },
    async close() {
      await Promise.all(listeners.splice(0).map((listening) => listening.close()));
      await worker.stop();
      await mcp.close();
    },
  };
}
