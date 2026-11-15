/**
 * The request pipeline: one tool call from an authenticated caller to a rendered result.
 * Order: the project is checked first (a call without one is refused with the fixed text and
 * counted), then the arguments, then the project's record and the inferred session, then the use
 * case, and last how the caller's person treats the project, which every result says. The first
 * result of a session also carries the session's brief, unless its harness was handed the brief
 * when the session began. A failure the caller can act on is a result with the one error shape,
 * never a throw.
 */
import {
  TOOL_NAMES,
  TOOLS,
  TREATMENT_TEXT,
  UNCHOSEN_NOTICE,
  type ToolDefinition,
  type ToolName,
  type ToolResults,
} from "@uketsugi/contracts";
import { sessionBrief } from "./brief-sources.ts";
import type { ComposedBrief } from "./brief.ts";
import type { CallContext } from "./context.ts";
import type { Caller, Session } from "./domain.ts";
import { ToolFailure, internal } from "./failure.ts";
import type { CorePorts, Identity } from "./ports.ts";
import { isPersonal, parseProject, projectRefusal, resolveProject } from "./project.ts";
import { createSessionInference, type ClientInfo, type SessionInference } from "./sessions.ts";
import { standingOf } from "./sharing.ts";
import { TOOL_TABLE, type Tool } from "./tools.ts";
import {
  endSession,
  keepTurn,
  noteSession,
  type Conversation,
  type TurnSide,
} from "./usecases/session-note.ts";
import { validateInput } from "./validate.ts";

/** A tool call's result, in the shape MCP carries it. */
export interface ToolCallResult {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

/** Thrown for a tool name the contract does not hold: a protocol error, not a tool result. */
export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`Unknown tool: ${name}`);
    this.name = "UnknownToolError";
  }
}

/** What a transport needs of core: the tools, the caller of a request, and a call. */
export interface App {
  readonly tools: readonly ToolDefinition[];
  /** The `WWW-Authenticate` value of a 401. */
  readonly challenge: string;
  /** The caller of a bearer credential; rejects with `AuthError`. */
  authenticate(bearer: string | undefined): Promise<Caller>;
  /** The person a dashboard sign-in belongs to; rejects with `AuthError`. */
  signIn(key: string): Promise<Caller>;
  /** A caller who signed in earlier, as they stand now; null once their credential no longer holds. */
  current(caller: Caller): Promise<Caller | null>;
  /** Runs one tool call. Rejects only with `UnknownToolError`. */
  callTool(
    caller: Caller,
    name: string,
    args: unknown,
    client: ClientInfo,
  ): Promise<ToolCallResult>;
  /**
   * Begins the session of a conversation whose harness says it is starting, in the project its
   * hook names as a call would, and returns the text of that session's brief. Null where the hook
   * names no project of the caller's: the brief then rides on the first call, as without a hook.
   */
  beginSession(caller: Caller, client: ClientInfo, project: unknown): Promise<string | null>;
  /**
   * Records where a conversation's session stands, in the agent's last message. Null where the
   * message holds nothing to keep or there is no session to put it on.
   */
  noteSession(caller: Caller, of: Conversation, message: string): Promise<Session | null>;
  /**
   * Keeps one side of a conversation's turn for the language model that reads its person's
   * sessions. False where no model reads them, or the side holds nothing to keep.
   */
  keepTurn(caller: Caller, of: Conversation, side: TurnSide): Promise<boolean>;
  /** Ends a conversation's session: what it last said is its last word. Null where it has none to end. */
  endSession(caller: Caller, of: Conversation): Promise<Session | null>;
}

export interface AppPorts extends CorePorts {
  readonly identity: Identity;
}

export interface AppOptions {
  /** Told of every error that was not a `ToolFailure`, before the caller is answered `internal`. */
  readonly onError?: (error: unknown) => void;
}

type Rendered = { result: object; text: string };

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/** Validates the arguments and binds them to the tool's row: its mark now, its use case and text once the session is known. */
function prepare<N extends ToolName>(name: N, args: unknown) {
  const tool: Tool<N> = TOOL_TABLE[name];
  const input = validateInput(name, args);
  return {
    mark: tool.mark,
    async run(ports: CorePorts, ctx: CallContext): Promise<Rendered> {
      const outcome = await tool.run(ports, ctx, input);
      // Read once the call has done its work: what the result says is what holds as it is made.
      const { treatment } = await standingOf(ports, ctx.caller, ctx.project.key);
      // What every result carries: the outcome and the envelope together are the tool's result.
      const result = {
        ...outcome,
        project: ctx.project.key,
        treatment: TREATMENT_TEXT[treatment],
        session: ctx.session.displayId,
        degraded: outcome.degraded ?? [],
      } as ToolResults[N];
      return { result, text: tool.render(result) };
    },
  };
}

/** What the pipeline keeps between calls: the session inference, and where unexpected errors go. */
interface Pipeline {
  readonly sessions: SessionInference;
  onError(error: unknown): void;
}

/** What the brief says the person has yet to decide about the project, if anything. */
async function noticeOf(ports: CorePorts, ctx: CallContext): Promise<string | null> {
  const { chosen } = await standingOf(ports, ctx.caller, ctx.project.key);
  // A project that cannot be shared has nothing left to choose.
  return chosen || isPersonal(ctx.project) ? null : UNCHOSEN_NOTICE;
}

/** A session's brief, with what its person has yet to decide about the project. */
async function briefOf(ports: CorePorts, ctx: CallContext): Promise<ComposedBrief> {
  return sessionBrief(ports, ctx, await noticeOf(ports, ctx));
}

/**
 * Runs the call that owes its session's brief and attaches the brief to its result. A call that
 * fails gives the brief back, so the session's next result carries it. A brief that cannot be
 * composed never fails the call it would have ridden on.
 */
async function withBrief(
  ports: CorePorts,
  pipeline: Pipeline,
  ctx: CallContext,
  call: () => Promise<Rendered>,
): Promise<Rendered> {
  let rendered: Rendered;
  try {
    rendered = await call();
  } catch (error) {
    await pipeline.sessions.releaseBrief(ctx.session);
    throw error;
  }
  try {
    const { brief, text } = await briefOf(ports, ctx);
    return { result: { ...rendered.result, brief }, text: `${rendered.text}\n\n${text}` };
  } catch (error) {
    pipeline.onError(error);
    await pipeline.sessions.releaseBrief(ctx.session);
    return rendered;
  }
}

async function run(
  ports: CorePorts,
  pipeline: Pipeline,
  caller: Caller,
  name: ToolName,
  args: unknown,
  client: ClientInfo,
): Promise<Rendered> {
  const { sessions } = pipeline;
  /** A call that names no usable project is counted on a session without one, and taught. */
  const refuse = async (): Promise<never> => {
    await sessions.enter(caller, client, null, "refused");
    throw await projectRefusal(ports, caller);
  };
  const named =
    typeof args === "object" && args !== null ? (args as { project?: unknown }).project : null;
  const ref = parseProject(named);
  if (ref === null) return refuse();
  const prepared = prepare(name, args);
  const project = await resolveProject(ports, caller, ref);
  if (project === null) return refuse();
  const { session, owesBrief } = await sessions.enter(caller, client, project.key, prepared.mark);
  const ctx: CallContext = { caller, project, session };
  const call = () => prepared.run(ports, ctx);
  return owesBrief ? withBrief(ports, pipeline, ctx, call) : call();
}

/** The request pipeline over the given ports. */
export function createApp(ports: AppPorts, options: AppOptions = {}): App {
  const pipeline: Pipeline = {
    sessions: createSessionInference(ports),
    onError: (error) => options.onError?.(error),
  };
  /** What a conversation's hook leaves on its session is recorded with the pipeline's one opener of sessions. */
  const words = { ...ports, sessions: pipeline.sessions };
  return {
    tools: TOOLS,
    challenge: ports.identity.challenge,
    authenticate: (bearer) => ports.identity.authenticate(bearer),
    signIn: (key) => ports.identity.signIn(key),
    current: (caller) => ports.identity.current(caller),
    async beginSession(caller, client, named) {
      const ref = parseProject(named);
      const project = ref === null ? null : await resolveProject(ports, caller, ref);
      if (project === null) return null;
      const session = await pipeline.sessions.begin(caller, client, project.key);
      try {
        return (await briefOf(ports, { caller, project, session })).text;
      } catch (error) {
        await pipeline.sessions.releaseBrief(session);
        throw error;
      }
    },
    noteSession: (caller, of, message) => noteSession(words, caller, of, message),
    keepTurn: (caller, of, side) => keepTurn(words, caller, of, side),
    endSession: (caller, of) => endSession(words, caller, of),
    async callTool(caller, name, args, client) {
      if (!isToolName(name)) throw new UnknownToolError(name);
      try {
        const { result, text } = await run(ports, pipeline, caller, name, args, client);
        return {
          content: [{ type: "text", text }],
          structuredContent: { ...result },
          isError: false,
        };
      } catch (error) {
        if (!(error instanceof ToolFailure)) options.onError?.(error);
        const failure = error instanceof ToolFailure ? error : internal();
        return {
          content: [{ type: "text", text: failure.toText() }],
          structuredContent: { ...failure.toToolError() },
          isError: true,
        };
      }
    },
  };
}
