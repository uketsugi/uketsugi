/**
 * `/api`: the dashboard's routes, the ones the host's command line calls and the one a harness's
 * hooks call (`hooks.ts`). The shapes are the contract's; every query and body is checked against
 * its schema by core, and every decision is a use case of core's. A request is a person's by its
 * bearer token, by the dashboard's cookie session, or as `/mcp` takes one that carries neither.
 *
 * Two kinds of route are narrower than that. What reaches every person's data or administers
 * the server (a snapshot of the store, people and their credentials, a sign-in code for the
 * operator) answers only a caller on this machine that sends the host's own secret, which no
 * harness is given. What only a person may do (choose how a project is treated, redact a fact,
 * undo a merge, make a named project) takes a signed-in browser, never a token.
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import {
  SIGN_IN_PATH,
  type ApiRequests,
  type DashboardSession,
  type HostProof,
  type SignInCode,
} from "@uketsugi/contracts";
import {
  activityReport,
  chooseTreatment,
  createNamedProject,
  exportMarkdown,
  factDetail,
  invitePerson,
  listFacts,
  listPeople,
  listProjects,
  listRulings,
  listTasks,
  redactFact,
  revertRuling,
  revokeToken,
  taskDetail,
  validateRequest,
  type App,
  type AppPorts,
} from "@uketsugi/core";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { every, some } from "hono/combine";
import { ipRestriction } from "hono/ip-restriction";
import { validator } from "hono/validator";
import {
  hostAuth,
  hostProof,
  takesNoToken,
  tokenAuth,
  type AuthEnv,
  type Operator,
  type SignIn,
} from "./auth.ts";
import { capabilityDescriptor, connectInfo } from "./connect.ts";
import { errorHandler, failed, noRoute, noSnapshot, personOnly, unauthorized } from "./errors.ts";
import { LOOPBACK_ADDRESSES, reachedAt } from "./guard.ts";
import { answerClaudeCode, ORIGIN_HEADER } from "./hooks.ts";
import { pluginsFrom } from "./plugins.ts";
import type { ToolUses } from "./tool-uses.ts";

export interface ApiDeps {
  readonly app: App;
  readonly ports: AppPorts;
  readonly signIn: SignIn;
  readonly onError: (error: unknown) => void;
  /** Whoever runs this server. Left out, nobody does, and its routes for them do not exist. */
  readonly operator?: Operator;
  /** Which conversation a harness's hook says a tool call belongs to. */
  readonly toolUses: ToolUses;
  /** The folder of plugins this server ships, as it stands on this machine; null where it has none. */
  readonly plugins: string | null;
  /** A copy of the whole store while it serves, where the store's host can make one. */
  readonly snapshot?: () => Promise<Blob>;
  /** Whether a request can only have come from the server's own machine: one that may carry no token. */
  readonly alone: (c: Context) => boolean;
}

/** The largest request body `/api` reads: what a hook sends holds an agent's last message, not a file. */
const MAX_BODY_BYTES = 256 * 1024;

/** Checks a request's query against its schema in the contract; a mismatch is a failure in the one shape. */
function query<N extends keyof ApiRequests>(name: N) {
  return validator("query", (sent) => validateRequest(name, "query", sent));
}

/** The same for a JSON body. */
function body<N extends keyof ApiRequests>(name: N) {
  return validator("json", (sent) => validateRequest(name, "body", sent));
}

/** A caller on this machine, by the address the connection comes from. */
const onThisMachine = ipRestriction(getConnInfo, { allowList: [...LOOPBACK_ADDRESSES] });

/** The routes that sign a request in by their own means: nobody, or the cookie alone. */
function signInRoutes(api: Hono<AuthEnv>, deps: ApiDeps): void {
  const { app, ports, signIn } = deps;
  api.get("/capabilities", (c) => c.json(capabilityDescriptor(app, ports)));
  api.get("/session", signIn.cookieAuth, (c) => {
    const login = signIn.loginOf(c);
    if (login === null) return failed(c, unauthorized());
    const session: DashboardSession = {
      person: c.get("caller").displayName,
      csrf: login.csrf,
      expires_at: login.expiresAt.toISOString(),
    };
    return c.json(session);
  });
  api.delete("/session", signIn.cookieAuth, (c) => {
    signIn.end(c);
    return c.body(null, 204);
  });
}

/**
 * What only a person may do: each takes the session of a signed-in browser, whatever token the
 * request also carries. A browser is signed in by something no harness holds, so no agent does
 * any of these for its person.
 */
function inPersonRoutes(api: Hono<AuthEnv>, { ports, signIn }: ApiDeps): void {
  const signedIn: MiddlewareHandler<AuthEnv> = (c, next) =>
    signIn.loginOf(c) === null ? Promise.resolve(failed(c, personOnly())) : next();
  const inPerson = every(signedIn, signIn.cookieAuth);
  api.post("/projects/choice", inPerson, body("ProjectChoiceRequest"), async (c) =>
    c.json(await chooseTreatment(ports, c.get("caller"), c.req.valid("json"))),
  );
  api.post("/projects", inPerson, body("NewProjectRequest"), async (c) =>
    c.json(await createNamedProject(ports, c.get("caller"), c.req.valid("json")), 201),
  );
  api.post("/facts/:id/redact", inPerson, async (c) =>
    c.json(await redactFact(ports, c.get("caller"), { id: c.req.param("id") })),
  );
  api.post("/rulings/:id/revert", inPerson, async (c) =>
    c.json(await revertRuling(ports, c.get("caller"), c.req.param("id"))),
  );
}

/**
 * The routes of whoever runs the server: what reaches every person's data, who may sign in, and
 * a sign-in code for the operator themselves. Each needs the host's own secret, from this
 * machine: a person's token is not it, the operator's own harness token included. A server with
 * no operator has none of these.
 */
function operatorRoutes(api: Hono<AuthEnv>, deps: ApiDeps): void {
  const { ports, operator, signIn, snapshot } = deps;
  if (operator === undefined || operator.key === "") return;
  // Asked before the secret is sent, so by nobody yet: the answer shows the secret to no one.
  api.get("/host-proof", onThisMachine, query("HostProofParams"), (c) => {
    const proof: HostProof = { proof: hostProof(operator.key, c.req.valid("query").challenge) };
    return c.json(proof);
  });
  const fromOperator = every(onThisMachine, hostAuth(operator));
  api.post("/sign-in-codes", fromOperator, (c) => {
    const { code, expiresAt } = signIn.mint(c.get("caller"));
    const link = new URL(SIGN_IN_PATH, c.req.url);
    link.searchParams.set("code", code);
    const minted: SignInCode = { code, url: link.href, expires_at: expiresAt.toISOString() };
    return c.json(minted);
  });
  api.get("/backup", fromOperator, async (c) => {
    if (snapshot === undefined) return failed(c, noSnapshot());
    c.header("Content-Type", "application/gzip");
    return c.body((await snapshot()).stream());
  });
  api.get("/people", fromOperator, async (c) => c.json(await listPeople(ports, c.get("caller"))));
  api.post("/people", fromOperator, body("InviteRequest"), async (c) =>
    c.json(await invitePerson(ports, c.get("caller"), c.req.valid("json")), 201),
  );
  api.post("/tokens/:id/revoke", fromOperator, async (c) =>
    c.json(await revokeToken(ports, c.get("caller"), c.req.param("id"))),
  );
}

/**
 * What the dashboard and an agent's token both reach, as whoever the request acts as: every read,
 * and what a harness's hooks send of its own session.
 */
function personRoutes(api: Hono<AuthEnv>, deps: ApiDeps): void {
  const { ports } = deps;
  api.get("/connect", async (c) => {
    // The lines depend on whether a harness added from where this request came needs a token.
    const tokenless = await takesNoToken(deps.app, deps.alone(c));
    return c.json(connectInfo(reachedAt(c), pluginsFrom(c, deps.plugins), !tokenless));
  });
  api.get("/facts", query("FactListParams"), async (c) =>
    c.json(await listFacts(ports, c.get("caller"), c.req.valid("query"))),
  );
  api.get("/facts/:id", async (c) =>
    c.json(await factDetail(ports, c.get("caller"), c.req.param("id"))),
  );
  api.get("/tasks", query("TaskListParams"), async (c) =>
    c.json(await listTasks(ports, c.get("caller"), c.req.valid("query"))),
  );
  api.get("/tasks/:id", async (c) =>
    c.json(await taskDetail(ports, c.get("caller"), c.req.param("id"))),
  );
  api.get("/rulings", async (c) => c.json(await listRulings(ports, c.get("caller"))));
  api.get("/activity", query("ActivityParams"), async (c) =>
    c.json(await activityReport(ports, c.get("caller"), c.req.valid("query"))),
  );
  api.get("/projects", async (c) => c.json(await listProjects(ports, c.get("caller"))));
  api.get("/export", query("ExportParams"), async (c) => {
    const files = await exportMarkdown(ports, c.get("caller"), c.req.valid("query").project);
    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="uketsugi-export.md"');
    return c.body(files.map((file) => file.content).join("\n"));
  });
  api.post("/hooks/claude-code", body("ClaudeCodeHook"), async (c) => {
    const origin = c.req.header(ORIGIN_HEADER);
    return c.json(await answerClaudeCode(deps, c.get("caller"), c.req.valid("json"), origin));
  });
}

/** The whole of `/api`, to be mounted under that path. */
export function apiRoutes(deps: ApiDeps): Hono<AuthEnv> {
  const api = new Hono<AuthEnv>();
  api.onError(errorHandler(deps.onError));
  api.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES }));
  api.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  signInRoutes(api, deps);
  inPersonRoutes(api, deps);
  operatorRoutes(api, deps);
  api.use("*", some(tokenAuth(deps.app, deps.alone), deps.signIn.cookieAuth));
  personRoutes(api, deps);
  api.all("*", (c) => failed(c, noRoute(c.req.method, c.req.path)));
  return api;
}
