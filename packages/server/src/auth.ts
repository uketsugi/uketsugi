/**
 * Who a request acts as, by three kinds of credential that never stand in for one another.
 * - A harness, a script and most of the command line send an agent token as a bearer, which the
 *   Identity port resolves: it calls the tools and reads.
 * - A person signs a browser in to the dashboard, which ends in a cookie session: from their own
 *   machine with the key they were given for it, which no harness holds, or on the host with a
 *   one-time code a terminal mints (`ukt ui`). What only a person may do needs that session.
 * - Whoever runs the server sends the host's own secret, which lives in its data directory and is
 *   printed for no harness: adding people, revoking, a backup and a sign-in code need it.
 * The session is held in memory: a restart signs every browser out.
 *
 * A session outlives the request that opened it, so each request asks the identity who its
 * person is now: a session whose token was revoked ends there, and one opened before the server
 * had other people sees what they share.
 *
 * Codes and cookies are 32 random bytes, kept only as SHA-256 digests, and compared as map keys or
 * in constant time. A code cannot be guessed, so wrong ones are not counted: counting them would
 * only let any page that can reach the server spend the person's real code.
 *
 * The cookie is HttpOnly and SameSite=Strict; its name carries the port, because cookies ignore
 * ports and two servers on one machine must not share a session. A request that changes something
 * must also carry the session's CSRF value in a header, which a page of another origin cannot read.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { API_CSRF_HEADER } from "@uketsugi/contracts";
import {
  AuthError,
  ToolFailure,
  type App,
  type Caller,
  type Clock,
  type IdGen,
} from "@uketsugi/core";
import type { Context, MiddlewareHandler } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { failed, foreign, notOperator, unauthorized } from "./errors.ts";
import { overTls } from "./guard.ts";

/** How long a one-time code can be exchanged. */
const CODE_TTL_MS = 2 * 60 * 1000;
/** How long a cookie session lasts. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** What a handler behind either check reads: the person the request acts as. */
export type AuthEnv = { Variables: { caller: Caller } };

/** Whether two secrets are the same, compared in constant time. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** What a request is told for each way its bearer token can fail it. */
export interface TokenRefusals {
  /** No Authorization header. */
  readonly none: () => ToolFailure;
  /** An Authorization header that holds no token. */
  readonly empty: () => ToolFailure;
  /** A token the server does not know. */
  readonly unknown: () => ToolFailure;
}

/** What `/api` says: its callers are the dashboard and scripts, and all three are told the same. */
const NOT_SIGNED_IN: TokenRefusals = {
  none: unauthorized,
  empty: unauthorized,
  unknown: unauthorized,
};

/**
 * Lets a request through as the person its bearer token belongs to, and sets `caller`. A request
 * that is not let through is told what `refusals` says for the way it failed.
 */
export function tokenAuth(
  app: Pick<App, "authenticate" | "challenge">,
  refusals: TokenRefusals = NOT_SIGNED_IN,
): MiddlewareHandler<AuthEnv> {
  const refused = (failure: ToolFailure) => ({
    wwwAuthenticateHeader: app.challenge,
    message: failure.toToolError(),
  });
  return bearerAuth<AuthEnv>({
    async verifyToken(token, c) {
      try {
        c.set("caller", await app.authenticate(token));
        return true;
      } catch (error) {
        if (error instanceof AuthError) return false;
        throw error;
      }
    },
    noAuthenticationHeader: refused(refusals.none()),
    invalidAuthenticationHeader: refused(refusals.empty()),
    invalidToken: refused(refusals.unknown()),
  });
}

/** A signed-in browser: who it acts as, and the value its changing requests must send back. */
export interface DashboardLogin {
  readonly caller: Caller;
  readonly csrf: string;
  readonly expiresAt: Date;
}

export interface SignIn {
  /** A new code that signs one browser in as `caller`. */
  mint(caller: Caller): { code: string; expiresAt: Date };
  /** `GET /sign-in?code=…`: exchanges the code for the cookie and sends the browser to the dashboard. */
  exchange(c: Context): Response;
  /** `POST /sign-in`: signs the browser in as the person a dashboard key belongs to; anything else is refused. */
  withKey(c: Context, key: string): Promise<Response>;
  /** The login behind a request's cookie, if it is live. */
  loginOf(c: Context): DashboardLogin | null;
  /** Ends the login behind a request's cookie and clears the cookie. */
  end(c: Context): void;
  /**
   * Lets a request through as its cookie's person as they stand now, and sets `caller`. A request
   * that changes something must come from this server's own page and carry the session's CSRF value.
   */
  cookieAuth: MiddlewareHandler<AuthEnv>;
}

/** What the sign-in page was given was no person's dashboard key. */
function unknownKey(): ToolFailure {
  return new ToolFailure("unauthorized", {
    what: "That is not a dashboard key this server knows.",
    meaning: "Nobody was signed in. The token a harness sends does not sign a person in.",
    next: "Paste the dashboard key you were given with your invitation, whole. If it is lost, whoever runs the server issues another with `ukt invite <your name> --key`.",
  });
}

/** Whoever runs the server: the secret only its host holds, and the person it acts as. */
export interface Operator {
  readonly principalId: string;
  /** The host's own secret: kept in the data directory and given to no harness. */
  readonly key: string;
  /** The operator as a caller, as they stand now. */
  caller(): Promise<Caller>;
}

/**
 * Lets a request through as whoever runs the server: it must carry the host's own secret. A
 * person's token, the operator's own among them, is refused: a harness holds that.
 */
export function hostAuth(operator: Operator): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (!sentByHost(c, operator)) return failed(c, notOperator());
    c.set("caller", await operator.caller());
    return next();
  };
}

/**
 * Whether a request carries the host's own secret as its bearer credential. A host whose secret
 * is empty has nobody to administer it: a request that sends none would otherwise equal it.
 */
export function sentByHost(c: Context, operator: Operator | undefined): boolean {
  if (operator === undefined || operator.key === "") return false;
  const sent = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
  return sameSecret(digest(sent), digest(operator.key));
}

/**
 * What proves that a server holds a host's secret without showing it: a keyed digest of a
 * challenge the asker made up. `ukt` asks for it before it sends the secret or a token to the
 * address a server left on record, where something else may be listening by now.
 */
export function hostProof(key: string, challenge: string): string {
  return createHmac("sha256", key).update(`uketsugi host proof\n${challenge}`).digest("hex");
}

const digest = (secret: string): string => createHash("sha256").update(secret).digest("hex");

/** Drops what has expired, so that neither map grows without bound. */
function sweep(entries: Map<string, { expiresAt: Date }>, now: number): void {
  for (const [key, entry] of entries) if (entry.expiresAt.getTime() <= now) entries.delete(key);
}

function cookieName(c: Context): string {
  return `ukt_session_${new URL(c.req.url).port || "0"}`;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** What mints a secret and reads the time: the two things sign-in takes from outside. */
interface Sources {
  readonly secret: () => string;
  readonly nowMs: () => number;
}

/** The cookie sessions of the browsers signed in now. */
interface CookieSessions {
  /** The login behind a request's cookie, if it is live. */
  readonly loginOf: (c: Context) => DashboardLogin | null;
  /** Opens a session for a person and gives the browser its cookie. */
  readonly open: (c: Context, caller: Caller) => void;
  /** Ends the login behind a request's cookie and clears the cookie. */
  readonly end: (c: Context) => void;
}

function cookieSessions({ secret, nowMs }: Sources): CookieSessions {
  const logins = new Map<string, DashboardLogin>();
  return {
    loginOf(c) {
      const cookie = getCookie(c, cookieName(c));
      const login = cookie === undefined ? undefined : logins.get(digest(cookie));
      return login !== undefined && login.expiresAt.getTime() > nowMs() ? login : null;
    },
    open(c, caller) {
      sweep(logins, nowMs());
      const cookie = secret();
      const expiresAt = new Date(nowMs() + SESSION_TTL_MS);
      logins.set(digest(cookie), { caller, csrf: secret(), expiresAt });
      setCookie(c, cookieName(c), cookie, {
        httpOnly: true,
        sameSite: "Strict",
        path: "/",
        maxAge: SESSION_TTL_MS / 1000,
        secure: overTls(c),
      });
    },
    end(c) {
      const cookie = getCookie(c, cookieName(c));
      if (cookie !== undefined) logins.delete(digest(cookie));
      deleteCookie(c, cookieName(c), { path: "/" });
    },
  };
}

export function createSignIn(
  ports: { clock: Clock; ids: IdGen },
  app: Pick<App, "signIn" | "current">,
): SignIn {
  const codes = new Map<string, { caller: Caller; expiresAt: Date }>();
  const fromOwnPage = csrf();
  const secret = (): string => Buffer.from(ports.ids.bytes(32)).toString("base64url");
  const nowMs = (): number => ports.clock.now().getTime();
  const { loginOf, open, end } = cookieSessions({ secret, nowMs });

  return {
    mint(caller) {
      sweep(codes, nowMs());
      const code = secret();
      const expiresAt = new Date(nowMs() + CODE_TTL_MS);
      codes.set(digest(code), { caller, expiresAt });
      return { code, expiresAt };
    },
    exchange(c) {
      const key = digest(c.req.query("code") ?? "");
      const pending = codes.get(key);
      codes.delete(key);
      c.header("Cache-Control", "no-store");
      if (pending === undefined || pending.expiresAt.getTime() <= nowMs()) {
        return c.text(
          "This sign-in link was already used or has expired. Run `ukt ui` for a new one.",
          401,
        );
      }
      open(c, pending.caller);
      return c.redirect("/", 303);
    },
    async withKey(c, key) {
      c.header("Cache-Control", "no-store");
      try {
        open(c, await app.signIn(key.trim()));
      } catch (error) {
        if (error instanceof AuthError) return failed(c, unknownKey());
        throw error;
      }
      return c.body(null, 204);
    },
    loginOf,
    end,
    async cookieAuth(c, next) {
      const login = loginOf(c);
      const caller = login === null ? null : await app.current(login.caller);
      if (login === null || caller === null) {
        end(c);
        return failed(c, unauthorized());
      }
      c.set("caller", caller);
      if (SAFE_METHODS.has(c.req.method)) return next();
      if (!sameSecret(c.req.header(API_CSRF_HEADER) ?? "", login.csrf)) {
        const what = `The request needs the ${API_CSRF_HEADER} header of the signed-in session.`;
        return failed(c, foreign(what));
      }
      return fromOwnPage(c, next);
    },
  };
}
