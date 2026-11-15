/**
 * What stands in front of every route, `/mcp` included: the checks that keep a web page the person
 * happens to have open from reaching a server on their own machine, and the headers the dashboard
 * is served with.
 *
 * - Host must name this server. A page that points its own domain at 127.0.0.1 (DNS rebinding)
 *   arrives with its own Host and is refused.
 * - Origin, when a browser sends one, must be this server's own, port included: cookies ignore
 *   ports, so another program's page on localhost is as foreign as any site.
 * - On `/mcp` and `/api`, a request a browser marks as coming from another origin is refused
 *   whatever it carries. A harness or a script sends no such mark.
 */
import {
  localhostAllowedHostnames,
  validateHostHeader,
  validateOriginHeader,
} from "@modelcontextprotocol/server";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { failed, foreign } from "./errors.ts";

/**
 * This machine as it reaches itself, per address family: its loopback address, and the address
 * that listens on every interface of the family. Every place that says "local" reads this.
 */
const LOCAL = [
  { loopback: "127.0.0.1", every: "0.0.0.0" },
  { loopback: "::1", every: "::" },
] as const;

/** The addresses a request from this machine arrives from. */
export const LOOPBACK_ADDRESSES: readonly string[] = LOCAL.map((family) => family.loopback);

/**
 * What a proxy or a tunnel adds to a request it passes on: the standard headers, and the ones the
 * common proxies and networks name the first sender in. One that runs on this machine connects
 * from a loopback address whoever it speaks for, so a request that carries any of these is taken
 * to come from elsewhere. No list holds them all, and a proxy that adds none cannot be told from
 * a local program: whoever puts one in front of a server asks every caller for a token.
 */
const PASSED_ON = /^via$|forwarded|(client|connecting|real)-ip|external-address/;

/**
 * Whether a request came straight from a program on this machine: its connection is from a
 * loopback address and nothing in it says it was passed on. A request with no connection behind
 * it, as a test hands one to `fetch`, did not.
 */
export function fromThisMachine(c: Context): boolean {
  let address: string | undefined;
  try {
    ({ address } = getConnInfo(c).remote);
  } catch {
    return false;
  }
  if (address === undefined || !LOOPBACK_ADDRESSES.includes(address)) return false;
  return ![...c.req.raw.headers.keys()].some((name) => PASSED_ON.test(name));
}

/** The address a server listens on unless it is told another. */
export const DEFAULT_HOST = LOCAL[0].loopback;

/** The loopback address at which this machine reaches a listener bound to every address; null for any other host. */
export function loopbackOfEvery(host: string): string | null {
  return LOCAL.find((family) => family.every === host)?.loopback ?? null;
}

/**
 * Whether the request reached the server over TLS: directly, or through a proxy that ends TLS and
 * says so (`X-Forwarded-Proto`, or `Forwarded`). A client that says so falsely only gets a cookie
 * its own plain requests will not carry, and addresses it cannot use.
 */
export function overTls(c: Context): boolean {
  const forwarded = /(?:^|[;,\s])proto="?https"?(?:$|[;,\s])/i.test(
    c.req.header("forwarded") ?? "",
  );
  const proto = (c.req.header("x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase();
  return new URL(c.req.url).protocol === "https:" || proto === "https" || forwarded;
}

/** The address the other end reached this server by, as they would type it again: no path. */
export function reachedAt(c: Context): string {
  return `${overTls(c) ? "https" : "http"}://${new URL(c.req.url).host}`;
}

/** Whether the other end reached this server by a name of this machine's own, so is on it. */
export function reachedLocally(c: Context): boolean {
  return localhostAllowedHostnames().includes(new URL(c.req.url).hostname);
}

/** Whether an Origin header names the same host and port the request was sent to. */
function sameOrigin(origin: string, host: string): boolean {
  try {
    const url = new URL(origin);
    return new URL(`${url.protocol}//${host}`).host === url.host;
  } catch {
    return false;
  }
}

const OWN_SITE = new Set(["same-origin", "none"]);

/**
 * Refuses a request whose Host, Origin or fetch metadata says it is not this server's own.
 * `names` holds the hostnames the server answers to, without ports and with an IPv6 address in
 * brackets; it is read on every request, so a name added once the server listens counts.
 */
export function requestGuard(names: ReadonlySet<string>): MiddlewareHandler {
  return async (c, next) => {
    const hostnames = [...names];
    const host = c.req.header("host") ?? "";
    const named = validateHostHeader(host, hostnames);
    if (!named.ok) {
      return failed(c, foreign(`The Host header does not name this server: ${named.message}.`));
    }
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== "") {
      const known = validateOriginHeader(origin, hostnames);
      if (!known.ok || !sameOrigin(origin, host)) {
        return failed(c, foreign("The request comes from another origin."));
      }
    }
    const site = c.req.header("sec-fetch-site");
    const guarded = c.req.path === "/mcp" || c.req.path.startsWith("/api/");
    if (guarded && site !== undefined && !OWN_SITE.has(site)) {
      return failed(c, foreign("The request comes from another site's page."));
    }
    return next();
  };
}

/**
 * The response headers of every route. The dashboard loads its own files and calls its own
 * `/api` and nothing else, is never framed, and sends no referrer. Strict-Transport-Security is
 * left to whatever terminates TLS: sent from a loopback name it would bind every other program
 * on that name.
 */
export function responseHeaders(): MiddlewareHandler {
  return secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
    xFrameOptions: "DENY",
    strictTransportSecurity: false,
  });
}
