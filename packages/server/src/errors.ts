/**
 * Every failure the server answers with, in the product's one error shape. Core raises most of
 * them as a `ToolFailure`; the few the server itself raises are worded here, and whatever a
 * middleware or a fault throws is brought to the same shape by the one error handler.
 */
import { API_ERROR_STATUS, TOKEN_ENV, type ErrorCode } from "@uketsugi/contracts";
import { ToolFailure } from "@uketsugi/core";
import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const NOT_DONE = "The request was not carried out.";

/** A request nobody signed: no token the server knows, and no live dashboard session. */
export function unauthorized(): ToolFailure {
  return new ToolFailure("unauthorized", {
    what: "Nobody is signed in on this request.",
    meaning: "The dashboard's session has ended, or the request carried no token the server knows.",
    next: "Sign in with your dashboard key on the sign-in page; if you run this server, you can also run `ukt ui` on its host and open the link it prints, and if someone else runs it, ask them for a key. A script sends a harness token as a bearer token.",
  });
}

/**
 * Why a request that carried no token is asked for one: the server can be `reached` from beyond
 * its own machine, or the request was; or its identity `asks` every caller for one.
 */
export type TokenNeed = "reached" | "asks";

/** What a request is told for each way its bearer token can fail it. */
export interface TokenRefusals {
  /** No token at all. */
  readonly none: (why: TokenNeed) => ToolFailure;
  /** An Authorization header that holds no token. */
  readonly empty: () => ToolFailure;
  /** A token the server does not know. */
  readonly unknown: () => ToolFailure;
}

/** What a harness is told: by `/mcp` when it does not accept it, and by `/register` when it asks to sign in with OAuth. */
export interface HarnessRefusals extends TokenRefusals {
  readonly register: () => ToolFailure;
}

/** How a person puts the token where a harness reads it, and adds the server again. */
const ADD_AGAIN = `set ${TOKEN_ENV} in the shell (if you run this server, on its host: export ${TOKEN_ENV}="$(ukt token)"; if someone else runs it, ask them for your token), remove the server from the harness and add it again with the command on the dashboard's Connect page`;

/**
 * What a harness is told when the open edition does not accept it, one for each way that happens. A harness
 * shows its person the beginning of this text and little else, so each says first what is wrong
 * with how the harness was added, then what to type.
 */
export const HARNESS_REFUSALS: HarnessRefusals = {
  /**
   * No token at all: the server was added by its address alone, which is enough only for the one
   * person of a server that nothing but their own machine reaches.
   */
  none: (why: TokenNeed) =>
    new ToolFailure("unauthorized", {
      what:
        why === "reached"
          ? "This harness sent no token, and this server takes one from whatever reaches it from beyond its own machine."
          : "This harness sent no token, and this server asks every caller for one.",
      meaning:
        why === "reached"
          ? "The server listens beyond its own machine, or the request was passed on by a proxy or a tunnel, so the address alone is not enough."
          : "It has more than one person, or whoever runs it turned tokens on, so the address alone is not enough.",
      next: `To connect: ${ADD_AGAIN}.`,
    }),
  /** An Authorization header no token can be read from: most often the variable in the add command was empty. */
  empty: () =>
    new ToolFailure("unauthorized", {
      what: "The Authorization header this harness sent holds no token.",
      meaning: `Most often ${TOKEN_ENV} was not set in the shell when the server was added to the harness, so the header was stored with nothing after "Bearer".`,
      next: `To connect: ${ADD_AGAIN}.`,
    }),
  /** A token the server does not know: replaced, revoked, or another server's. */
  unknown: () =>
    new ToolFailure("unauthorized", {
      what: "This server does not know the token this harness sent.",
      meaning: "The token was replaced or revoked, or belongs to another server.",
      next: `Use your current token: ${ADD_AGAIN}.`,
    }),
  /**
   * Asked to sign in with OAuth. A harness that was given no token takes the server's 401 for an
   * invitation to register as an OAuth client (Claude Code 2.1.325 posts to `/register`), and what
   * that request is answered is all it shows its person.
   */
  register: () =>
    new ToolFailure("not_found", {
      what: "This server takes a token, not an OAuth sign-in.",
      meaning: "The harness asked to sign in because the server was added to it without a token.",
      next: `To connect: ${ADD_AGAIN}.`,
    }),
};

/** A request that did not come from this server's own page or from a client of it. */
export function foreign(what: string): ToolFailure {
  return new ToolFailure("forbidden", {
    what,
    meaning: "The request did not come from this server's own page or from a client of it.",
    next: "Open the dashboard at the server's own address, or call the server directly.",
  });
}

/** A store its host cannot copy while it serves: one kept on a PostgreSQL server. */
export function noSnapshot(): ToolFailure {
  return new ToolFailure("unsupported", {
    what: "This server's store is kept on a PostgreSQL server, which the server does not copy.",
    meaning: "No snapshot was made.",
    next: "Back the database up with PostgreSQL's own tools, for example pg_dump.",
  });
}

/** A request for one of the routes that are only for whoever runs the server, without the host's own secret. */
export function notOperator(): ToolFailure {
  return new ToolFailure("forbidden", {
    what: "This is for whoever runs the server: it reaches every person's data.",
    meaning:
      "The request did not carry the host's own secret, which no harness is given, so nothing was done.",
    next: "Run the `ukt` command for it on the server's host.",
  });
}

/** A request to do what only a person may, with a token and no signed-in browser. */
export function personOnly(): ToolFailure {
  return new ToolFailure("forbidden", {
    what: "This is a person's to do, signed in to the dashboard: a token is not enough.",
    meaning: "The request carried no signed-in browser's session, so nothing was changed.",
    next: "Sign in to the dashboard and do it there.",
  });
}

/** Answers with a failure: its body, and the status its code maps to unless one is given. */
export function failed(c: Context, failure: ToolFailure, status?: number): Response {
  const code = status ?? API_ERROR_STATUS[failure.code];
  return c.json(failure.toToolError(), code as ContentfulStatusCode);
}

/** Answers a request for a route that does not exist. */
export function notFound(c: Context): Response {
  const { method, path } = c.req;
  const what = `No route ${method} ${path}.`;
  return failed(
    c,
    new ToolFailure("not_found", { what, meaning: NOT_DONE, next: "See the API's contract." }),
  );
}

/** The code nearest an HTTP status a middleware refused a request with. */
function codeOf(status: number): ErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  return status === 404 ? "not_found" : "invalid_input";
}

/**
 * What a middleware threw, in the one shape. One that already answers in JSON (the bearer check,
 * with its challenge header) is sent as it is; a bare status keeps its status and gains a body.
 */
function refusedByMiddleware(c: Context, error: HTTPException): Response {
  const response = error.getResponse();
  if (response.headers.get("content-type")?.includes("application/json") === true) return response;
  const what = `The request was refused: ${error.message || `status ${error.status}`}.`;
  const next = "Send the request as the API's contract describes it.";
  return failed(
    c,
    new ToolFailure(codeOf(error.status), { what, meaning: NOT_DONE, next }),
    error.status,
  );
}

/** The error handler of every route. `report` is told of what no caller could act on. */
export function errorHandler(report: (error: unknown) => void): ErrorHandler {
  return (error, c) => {
    if (error instanceof ToolFailure) return failed(c, error);
    if (error instanceof HTTPException) return refusedByMiddleware(c, error);
    report(error);
    const what = "The server failed while handling the request.";
    // Whether the same request would pass a second time is not known, and the answer says so
    // (`retry` is false): the cause is in the server's log, where whoever runs it reads it.
    const next = "If it goes on, whoever runs the server finds the cause in the server's log.";
    return failed(c, new ToolFailure("internal", { what, meaning: NOT_DONE, next }));
  };
}
