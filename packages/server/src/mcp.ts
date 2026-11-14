/**
 * `/mcp`: Streamable HTTP through the MCP SDK, stateless. Each request gets a fresh low-level
 * server for its caller, so nothing is kept between requests and both protocol revisions are
 * answered by the same handlers. Tool arguments reach core unvalidated: a fault in them is a tool
 * result with the product's error shape, never an SDK error. The two commands, `activate` and
 * `setup`, are MCP prompts without arguments: each returns its text as one message from the person.
 * `setup` names the instruction file of the harness that asks for it.
 */
import {
  CONTRACT_VERSION,
  PROMPT_DESCRIPTIONS,
  promptText,
  SERVER_INSTRUCTIONS,
  type PromptName,
} from "@uketsugi/contracts";
import {
  UnknownToolError,
  type App,
  type Caller,
  type ClientInfo,
  type Clock,
  type IdGen,
} from "@uketsugi/core";
import {
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type McpHttpHandler,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  CONVERSATION_ID_KEYS,
  instructionFileOf,
  SERVER_NAME,
  TOOL_USE_ID_KEYS,
} from "./connect.ts";
import { createConnections, type Connections } from "./connections.ts";
import type { ToolUses } from "./tool-uses.ts";

/** A client's word about itself, trimmed and bounded: it becomes part of a session's key. */
function textOf(value: unknown, max = 120): string | null {
  const text = typeof value === "string" ? value.trim().slice(0, max) : "";
  return text === "" ? null : text;
}

/**
 * What the client says of itself. The newer revision names the client on every request; the older
 * one only at `initialize`, which a stateless server has not kept, so the first product of the
 * User-Agent stands in for it.
 */
function saidBy(server: Server, ctx: ServerContext): ClientInfo {
  const envelope: Record<string, unknown> = ctx.mcpReq.envelope ?? {};
  const sent = envelope[CLIENT_INFO_META_KEY] as { name?: unknown; version?: unknown } | undefined;
  const named = sent ?? server.getClientVersion();
  const [product, productVersion] = (ctx.http?.req?.headers.get("user-agent") ?? "").split(/[/\s]/);
  const meta: Record<string, unknown> = ctx.mcpReq._meta ?? {};
  const conversationId = CONVERSATION_ID_KEYS.map((key) => textOf(meta[key])).find(
    (id) => id !== null,
  );
  return {
    name: textOf(named?.name) ?? textOf(product) ?? "unknown",
    version: textOf(named?.version) ?? (named === undefined ? textOf(productVersion) : null),
    conversationId: conversationId ?? null,
  };
}

/** What every request is read with: who sent it, and what tells which conversation it belongs to. */
interface Asked {
  readonly caller: Caller;
  readonly connections: Connections;
  readonly toolUses: ToolUses;
}

/**
 * The client of a request, with the conversation the request belongs to: the client's own id
 * where it sends one; else the conversation its hook said this call belongs to; else the
 * connection the request came on. Every request is read with this, the lists a client opens with
 * among them, since a connection is known from its beginning. `call` is given for a tool call:
 * its arguments, which name its project.
 */
function clientOf(
  server: Server,
  ctx: ServerContext,
  { caller, connections, toolUses }: Asked,
  call?: Record<string, unknown>,
): ClientInfo {
  const said = saidBy(server, ctx);
  if (said.conversationId !== null) return said;
  const project = call?.["project"];
  const connection = connections.of({
    person: caller.principalId,
    client: said.name,
    number: ctx.mcpReq.id,
    call: call !== undefined,
    project: typeof project === "string" ? project : null,
  });
  const meta: Record<string, unknown> = ctx.mcpReq._meta ?? {};
  const toolUse = TOOL_USE_ID_KEYS.map((key) => textOf(meta[key])).find((id) => id !== null);
  const told = toolUse === undefined ? null : toolUses.of(caller.principalId, toolUse);
  return { ...said, conversationId: told ?? connection };
}

function isPromptName(name: string): name is PromptName {
  return Object.hasOwn(PROMPT_DESCRIPTIONS, name);
}

/** The two commands, offered the same to every caller. */
function servePrompts(server: Server, asked: Asked): void {
  server.setRequestHandler("prompts/list", (_request, ctx) => {
    clientOf(server, ctx, asked);
    return {
      prompts: Object.entries(PROMPT_DESCRIPTIONS).map(([name, description]) => ({
        name,
        description,
      })),
    };
  });
  server.setRequestHandler("prompts/get", (request, ctx) => {
    const { name } = request.params;
    if (!isPromptName(name)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown prompt: ${name}`);
    }
    const text = promptText(name, instructionFileOf(clientOf(server, ctx, asked).name));
    return {
      description: PROMPT_DESCRIPTIONS[name],
      messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
    };
  });
}

function serverFor(app: App, asked: Asked): Server {
  const server = new Server(
    { name: SERVER_NAME, version: CONTRACT_VERSION },
    { capabilities: { tools: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  servePrompts(server, asked);
  server.setRequestHandler("tools/list", (_request, ctx) => {
    clientOf(server, ctx, asked);
    return {
      tools: app.tools.map((tool) => ({
        ...tool,
        inputSchema: { type: "object" as const, ...tool.inputSchema },
      })),
    };
  });
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const { name, arguments: args } = request.params;
    try {
      const sent = args ?? {};
      const result = await app.callTool(
        asked.caller,
        name,
        sent,
        clientOf(server, ctx, asked, sent),
      );
      return {
        content: result.content,
        structuredContent: result.structuredContent,
        isError: result.isError,
      };
    } catch (error) {
      if (error instanceof UnknownToolError) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message);
      }
      throw error;
    }
  });
  return server;
}

/** The MCP handler: `fetch(request, caller)` serves one request for an authenticated caller. */
export interface McpEndpoint {
  fetch(request: Request, caller: Caller): Promise<Response>;
  close(): Promise<void>;
}

export function createMcpEndpoint(
  app: App,
  ports: { clock: Clock; ids: IdGen },
  toolUses: ToolUses,
  onError: (error: unknown) => void,
): McpEndpoint {
  const connections = createConnections(ports);
  const handler: McpHttpHandler = createMcpHandler(
    (ctx) => {
      const caller = ctx.authInfo?.extra?.caller as Caller | undefined;
      if (caller === undefined)
        throw new Error("an MCP server was built for an unauthenticated request");
      return serverFor(app, { caller, connections, toolUses });
    },
    { legacy: "stateless", onerror: onError },
  );
  return {
    fetch: (request, caller) =>
      handler.fetch(request, {
        authInfo: { token: "", clientId: caller.principalId, scopes: [], extra: { caller } },
      }),
    close: () => handler.close(),
  };
}
