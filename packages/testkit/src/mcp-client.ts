import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { McpRevision } from "@uketsugi/contracts";

/** A tool call's result as a client receives it. */
export interface McpCallResult {
  readonly text: string;
  readonly structuredContent: Record<string, unknown> | undefined;
  readonly isError: boolean;
}

export interface McpTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: unknown;
}

/** A connected MCP client that talks to a real server over HTTP. */
export interface McpTestClient {
  readonly protocol: McpRevision;
  instructions(): string | undefined;
  listTools(): Promise<McpTool[]>;
  /** Calls a tool; `meta` is what the client says beside the call (`_meta`), as a harness that numbers its calls does. */
  callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<McpCallResult>;
  listPrompts(): Promise<{ name: string; description?: string | undefined }[]>;
  getPrompt(name: string): Promise<string>;
  close(): Promise<void>;
}

export interface McpConnectOptions {
  /** The server's `/mcp` URL. */
  readonly url: string;
  /** The bearer token; left out, the client sends none. */
  readonly token?: string;
  /** The revision to speak. The older one opens with the `initialize` handshake. */
  readonly protocol?: McpRevision;
  /** How the client names itself; sessions are inferred from it. */
  readonly client?: { name: string; version: string };
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

/** Connects the MCP SDK's client to a server, as a harness added by URL would. */
export async function connectMcp(options: McpConnectOptions): Promise<McpTestClient> {
  const protocol = options.protocol ?? "2026-07-28";
  const client = new Client(options.client ?? { name: "uketsugi-testkit", version: "0.0.0" }, {
    versionNegotiation: { mode: protocol === "2026-07-28" ? { pin: protocol } : "legacy" },
  });
  const headers: Record<string, string> =
    options.token === undefined ? {} : { authorization: `Bearer ${options.token}` };
  await client.connect(
    new StreamableHTTPClientTransport(new URL(options.url), { requestInit: { headers } }),
  );
  return {
    protocol,
    instructions: () => client.getInstructions(),
    listTools: async () => (await client.listTools()).tools,
    async callTool(name, args, meta) {
      const said = meta === undefined ? {} : { _meta: meta };
      const result = await client.callTool({ name, arguments: args, ...said });
      const content = Array.isArray(result.content) ? result.content : [];
      return {
        text: textOf(content),
        structuredContent: result.structuredContent as Record<string, unknown> | undefined,
        isError: result.isError === true,
      };
    },
    listPrompts: async () => (await client.listPrompts()).prompts,
    async getPrompt(name) {
      const result = await client.getPrompt({ name });
      return result.messages
        .map((m) => (m.content.type === "text" ? m.content.text : ""))
        .join("\n");
    },
    close: () => client.close(),
  };
}
