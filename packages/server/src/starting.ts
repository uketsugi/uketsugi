/**
 * What the server answers from the moment it listens until its store is open. Opening a store
 * that was not shut down cleanly takes as long as the disk takes, and a server that does not
 * listen meanwhile looks dead to everyone who asks and cannot be told why. So the server listens
 * first, and until the store is open it answers every request in the one error shape with what it
 * is doing, `/healthz` with where the recovery has got to, and `/api/host-proof`, which `ukt`
 * asks before it trusts the address a server left on record, as it always does.
 */
import { ToolFailure } from "@uketsugi/core";
import { describeRecovery, type RecoveryProgress } from "@uketsugi/store";
import { Hono } from "hono";
import { hostProofRoute } from "./api.ts";
import type { AuthEnv } from "./auth.ts";
import { errorHandler, failed } from "./errors.ts";
import { requestGuard, responseHeaders } from "./guard.ts";

/**
 * What the server is doing before its store is open: opening it, or recovering it first. It is
 * also the body of `/healthz` meanwhile, and `ukt doctor` is the one that reads it.
 */
export type Starting =
  { readonly status: "starting" } | ({ readonly status: "recovering" } & RecoveryProgress);

/** How soon a client may ask again, in seconds. */
const RETRY_AFTER_S = 5;

/** What a request is told while the store is not open. */
export function startingFailure(state: Starting): ToolFailure {
  if (state.status === "starting")
    return new ToolFailure("unavailable", {
      what: "Uketsugi is starting.",
      meaning: "The server is listening and has not opened its store yet.",
      next: "Try again in a few seconds.",
    });
  return new ToolFailure("unavailable", {
    what: `Uketsugi is recovering its store after an unclean stop: ${describeRecovery(state)}.`,
    meaning:
      "The store was not shut down cleanly the last time (a power cut, a kill, or a stop that was cut short), so it is put right before anything is read or written.",
    next: "Try again in a minute. `ukt doctor` on the server's host shows how far it has got, and stopping the server is safe: the next start recovers again.",
  });
}

/** The server before its store is open, as a handler of requests; `state` is read on every request. */
export function startingApp(options: {
  readonly names: ReadonlySet<string>;
  readonly hostKey: string | undefined;
  readonly state: () => Starting;
  readonly onError: (error: unknown) => void;
}): Hono<AuthEnv> {
  const { names, hostKey, state, onError } = options;
  const http = new Hono<AuthEnv>();
  http.onError(errorHandler(onError));
  http.use("*", requestGuard(names));
  http.use("*", responseHeaders());
  http.get("/healthz", (c) => c.json(state(), 503, { "Retry-After": String(RETRY_AFTER_S) }));
  // A harness's request is answered in JSON-RPC, the words of the error being what its agent reads.
  http.all("/mcp", async (c) => {
    const sent = (await c.req.json().catch(() => null)) as { id?: unknown } | null;
    const error = { code: -32000, message: startingFailure(state()).toText() };
    return c.json({ jsonrpc: "2.0", id: sent?.id ?? null, error }, 503);
  });
  if (hostKey !== undefined && hostKey !== "") {
    const api = new Hono<AuthEnv>();
    hostProofRoute(api, hostKey);
    http.route("/api", api);
  }
  http.all("*", (c) => failed(c, startingFailure(state())));
  return http;
}
