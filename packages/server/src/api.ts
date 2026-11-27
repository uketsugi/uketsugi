/**
 * `/api`: the dashboard's routes, the ones the host's command line calls and the one a harness's
 * hooks call (`hooks.ts`). The shapes are the contract's; every query and body is checked against
 * its schema by core, and every decision is a use case of core's. A request is a person's by its
 * bearer token, by the dashboard's cookie session, or as `/mcp` takes one that carries neither.
 *
 * Two kinds of route are narrower than that. What reaches every person's data or administers
 * the server (a snapshot of the store, people and their credentials, a sign-in code for the
 * operator) answers only a caller on this machine that sends the host's own secret, which no
 * harness is given. What only a person may do (choose how a project is treated, redact, correct or confirm a
 * fact, close a task, remove a session's note, delete a project, undo a merge, make a named
 * project) takes a signed-in browser, never a token.
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import {
  SIGN_IN_PATH,
  type ApiRequests,
  type DashboardSession,
  type FactConfirmation,
  type FactCorrection,
  type HostProof,
  type NewProjectRequest,
  type ProjectChoiceRequest,
  type ProjectNamed,
  type SignInCode,
  type TokenReplaced,
} from "@uketsugi/contracts";
import {
  activityReport,
  checkModel,
  chooseTreatment,
  closeTask,
  confirmFact,
  correctFact,
  createNamedProject,
  deleteProject,
  exportMarkdown,
  factDetail,
  invitePerson,
  listFacts,
  listPeople,
  listProjects,
  listRulings,
  listTasks,
  projectContents,
  redactFact,
  removeNote,
  removePerson,
  replaceTokens,
  revertRuling,
  revokeToken,
  taskDetail,
  validateRequest,
  type App,
  type AppPorts,
  type Caller,
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
import type { Edition } from "./compose.ts";
import { capabilityDescriptor, connectInfo, withoutToken } from "./connect.ts";
import { signsIn } from "./dashboard-words.ts";
import { errorHandler, failed, noSnapshot, notFound, personOnly, unauthorized } from "./errors.ts";
import { LOOPBACK_ADDRESSES, reachedAt } from "./guard.ts";
import {
  answerClaudeCode,
  CAPTURE_HEADER,
  DIRECTORY_HEADER,
  isOn,
  MACHINE_HEADER,
  ORIGIN_HEADER,
} from "./hooks.ts";
import { pluginsFrom } from "./plugins.ts";
import type { ToolUses } from "./tool-uses.ts";

export interface ApiDeps {
  readonly app: App;
  readonly ports: AppPorts;
  /** The edition: its name and the dashboard's words, for the capability descriptor, and what it says to a request nobody signed. */
  readonly edition: Edition;
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
export function body<N extends keyof ApiRequests>(name: N) {
  return validator("json", (sent) => validateRequest(name, "body", sent));
}

/**
 * One use case for the person the request is signed in as, given the id its path names and what
 * the request sent (its JSON body or its query, already checked against its schema).
 */
const onRequest =
  <S, R>(
    from: "json" | "query" | null,
    use: (caller: Caller, id: string, sent: S) => Promise<R>,
    status: 200 | 201 = 200,
  ) =>
  async (c: Context<AuthEnv>) => {
    const sent: unknown =
      from === null ? undefined : from === "json" ? await c.req.json() : c.req.query();
    return c.json(await use(c.get("caller"), c.req.param("id") ?? "", sent as S), status);
  };

/** The same for a use case that needs nothing but the record the path names. */
const onRecord = <R>(use: (caller: Caller, id: string) => Promise<R>) =>
  onRequest(null, (caller, id) => use(caller, id));

/** A caller on this machine, by the address the connection comes from. */
const onThisMachine = ipRestriction(getConnInfo, { allowList: [...LOOPBACK_ADDRESSES] });

/** The routes that sign a request in by their own means: nobody, or the cookie alone. */
function signInRoutes(api: Hono<AuthEnv>, deps: ApiDeps): void {
  const { app, ports, signIn, edition } = deps;
  api.get("/capabilities", async (c) => c.json(await capabilityDescriptor(edition, app, ports)));
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
  api.post(
    "/projects/choice",
    inPerson,
    body("ProjectChoiceRequest"),
    onRequest("json", (caller, _id, said: ProjectChoiceRequest) =>
      chooseTreatment(ports, caller, said),
    ),
  );
  api.post(
    "/projects",
    inPerson,
    body("NewProjectRequest"),
    onRequest(
      "json",
      (caller, _id, said: NewProjectRequest) => createNamedProject(ports, caller, said),
      201,
    ),
  );
  api.post(
    "/facts/:id/redact",
    inPerson,
    onRecord((caller, id) => redactFact(ports, caller, { id })),
  );
  api.post(
    "/facts/:id/correct",
    inPerson,
    body("FactCorrection"),
    onRequest("json", (caller, id, said: FactCorrection) => correctFact(ports, caller, id, said)),
  );
  api.post(
    "/facts/:id/confirm",
    inPerson,
    body("FactConfirmation"),
    onRequest("json", (caller, id, said: FactConfirmation) => confirmFact(ports, caller, id, said)),
  );
  api.post(
    "/tasks/:id/close",
    inPerson,
    onRecord((caller, id) => closeTask(ports, caller, id)),
  );
  api.delete(
    "/sessions/:id/note",
    inPerson,
    onRecord((caller, id) => removeNote(ports, caller, id)),
  );
  api.delete(
    "/projects",
    inPerson,
    body("ProjectNamed"),
    onRequest("json", (caller, _id, said: ProjectNamed) => deleteProject(ports, caller, said)),
  );
  api.post(
    "/rulings/:id/revert",
    inPerson,
    onRecord((caller, id) => revertRuling(ports, caller, id)),
  );
}

/**
 * `/host-proof`, asked before the secret is sent, so by nobody yet: the answer shows the secret
 * to no one. The server answers it from the moment it listens, before its store is open.
 */
export function hostProofRoute(api: Hono<AuthEnv>, key: string): void {
  api.get("/host-proof", onThisMachine, query("HostProofParams"), (c) => {
    const proof: HostProof = { proof: hostProof(key, c.req.valid("query").challenge) };
    return c.json(proof);
  });
}

/**
 * The routes of whoever runs the server: what reaches every person's data, who may sign in,
 * whether the language model they configured answers, and a sign-in code for the operator
 * themselves. Each needs the host's own secret, from this
 * machine: a person's token is not it, the operator's own harness token included. A server with
 * no operator has none of these.
 */
function operatorRoutes(api: Hono<AuthEnv>, deps: ApiDeps): void {
  const { ports, operator, signIn, snapshot } = deps;
  if (operator === undefined || operator.key === "") return;
  hostProofRoute(api, operator.key);
  const fromOperator = every(onThisMachine, hostAuth(operator));
  api.post("/sign-in-codes", fromOperator, (c) => {
    const { code, expiresAt } = signIn.mint(c.get("caller"));
    const link = new URL(SIGN_IN_PATH, c.req.url);
    link.searchParams.set("code", code);
    const minted: SignInCode = { code, url: link.href, expires_at: expiresAt.toISOString() };
    return c.json(minted);
  });
  api.post("/token/rotate", fromOperator, async (c) => {
    const replaced: TokenReplaced = await replaceTokens(ports, c.get("caller"));
    return c.json(replaced);
  });
  api.get("/backup", fromOperator, async (c) => {
    if (snapshot === undefined) return failed(c, noSnapshot());
    c.header("Content-Type", "application/gzip");
    return c.body((await snapshot()).stream());
  });
  // Asks the provider one small question, which costs its operator a few tokens: theirs to ask.
  api.post("/model-check", fromOperator, async (c) => c.json(await checkModel(ports)));
  api.post("/people/:id/remove", fromOperator, async (c) => {
    const gone = await removePerson(ports, c.get("caller"), c.req.param("id"));
    return c.json(gone);
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
    const words = deps.edition.dashboard;
    const signedIn = words !== undefined && signsIn(words);
    const tokenless = signedIn || (await takesNoToken(deps.app, deps.alone(c)));
    const info = connectInfo(reachedAt(c), pluginsFrom(c, deps.plugins), !tokenless);
    if (words === undefined) return c.json(info);
    // An edition whose harnesses sign in has no token to name; any other says its own command.
    if (signsIn(words)) return c.json(withoutToken(info));
    return c.json({ ...info, token_command: words.token_command });
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
  api.get(
    "/projects/contents",
    query("ProjectNamed"),
    onRequest("query", (caller, _id, said: ProjectNamed) => projectContents(ports, caller, said)),
  );
  api.get("/export", query("ExportParams"), async (c) => {
    const files = await exportMarkdown(ports, c.get("caller"), c.req.valid("query").project);
    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="uketsugi-export.md"');
    return c.body(files.map((file) => file.content).join("\n"));
  });
  api.post("/hooks/claude-code", body("ClaudeCodeHook"), async (c) => {
    const sent = {
      origin: c.req.header(ORIGIN_HEADER),
      machine: c.req.header(MACHINE_HEADER),
      directory: c.req.header(DIRECTORY_HEADER),
      capture: isOn(c.req.header(CAPTURE_HEADER)),
    };
    return c.json(await answerClaudeCode(deps, c.get("caller"), c.req.valid("json"), sent));
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
  api.all("*", notFound);
  return api;
}
