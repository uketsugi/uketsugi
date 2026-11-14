/**
 * What a client or the dashboard learns about this server before it uses it: the capability
 * descriptor, and the Connect page's set-up, per harness. Everything the server knows about one
 * harness is its row in `HARNESSES`. How each names and delivers the two commands is what the
 * experiments measured (5D stage 2, 5E): Claude Code lists a server's MCP prompts as commands;
 * Antigravity never asks a server for its prompts.
 */
import {
  CONTRACT_VERSION,
  FENCED_BLOCK,
  MCP_REVISIONS,
  pathPrintedBy,
  PROMPT_DESCRIPTIONS,
  TOKEN_ENV,
  type CapabilityDescriptor,
  type ConnectHarness,
  type ConnectInfo,
  type PromptName,
} from "@uketsugi/contracts";
import { JOB_KINDS, type App, type AppPorts } from "@uketsugi/core";

/** The name the server is added to a harness under; the commands' names follow from it. */
export const SERVER_NAME = "uketsugi";

const BEARER = `Bearer $${TOKEN_ENV}`;

interface Harness {
  /** The name its MCP client gives on a call, and its key on the Connect page. */
  readonly id: string;
  readonly name: string;
  /** The user-level instruction file its set-up writes the block to, where the server knows it: the place it usually is. */
  readonly instructionFile?: string;
  /**
   * A shell command that prints that file's path in the harness's own environment, for a harness
   * whose file is not always in the usual place. Its agent runs it instead of working the path out.
   */
  readonly instructionFileCommand?: string;
  /** Where its own conversation id arrives in a request's `_meta`, if it sends one. */
  readonly conversationIdKey?: string;
  /** How the person adds the server at `mcpUrl` to it, and what they type then. */
  connect(
    mcpUrl: string,
  ): Omit<ConnectHarness, "id" | "name" | "instruction_file" | "instruction_file_command">;
}

const HARNESSES: readonly Harness[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    instructionFile: "~/.claude/CLAUDE.md",
    // Claude Code keeps its configuration, this file included, in the folder CLAUDE_CONFIG_DIR
    // names where that is set, and under the home it runs in, whichever that is.
    instructionFileCommand: 'echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/CLAUDE.md"',
    connect: (mcpUrl) => ({
      add: `claude mcp add --transport http --scope user ${SERVER_NAME} ${mcpUrl} --header "Authorization: ${BEARER}"`,
      add_kind: "command",
      remove: `claude mcp remove ${SERVER_NAME} -s user`,
      setup: `/${SERVER_NAME}:setup`,
      activate: `/${SERVER_NAME}:activate`,
      note: `\`claude -p\` refuses every call to the server until its tools are allowed: add --allowedTools mcp__${SERVER_NAME}. There the commands are /mcp__${SERVER_NAME}__setup and /mcp__${SERVER_NAME}__activate. Type set-up in an interactive session: with \`claude -p\` nobody is there to allow the edit of the file.`,
    }),
  },
  {
    id: "antigravity",
    name: "Antigravity",
    instructionFile: "~/.gemini/GEMINI.md",
    conversationIdKey: "antigravity.google/conversation_id",
    connect: (mcpUrl) => ({
      add: JSON.stringify(
        { mcpServers: { [SERVER_NAME]: { url: mcpUrl, headers: { Authorization: BEARER } } } },
        null,
        2,
      ),
      add_kind: "json",
      add_file: "~/.gemini/config/mcp_config.json",
      note: `Antigravity fills in no variable: put the token itself in place of $${TOKEN_ENV}.`,
    }),
  },
  {
    id: "other",
    name: "Another client",
    connect: (mcpUrl) => ({
      add: mcpUrl,
      add_kind: "url",
      note: `Any client that takes a remote MCP server by its URL: add this one under the name ${SERVER_NAME}, with the header "Authorization: Bearer" and the token.`,
    }),
  },
];

/** Where a client's own conversation id may arrive in a request's `_meta`: each harness's key. */
export const CONVERSATION_ID_KEYS = HARNESSES.flatMap((harness) =>
  harness.conversationIdKey === undefined ? [] : [harness.conversationIdKey],
);

/**
 * How the instruction file of the harness whose client gives this name is named to its agent: by
 * the command that prints its path where the harness has one, else by its path; null for a
 * harness the server does not know.
 */
export function instructionFileOf(clientName: string): string | null {
  const harness = HARNESSES.find((known) => known.id === clientName);
  if (harness?.instructionFileCommand !== undefined)
    return pathPrintedBy(harness.instructionFileCommand);
  return harness?.instructionFile ?? null;
}

/** The descriptor of this server as it is composed now. */
export function capabilityDescriptor(
  app: App,
  ports: Pick<AppPorts, "embedder" | "runner">,
): CapabilityDescriptor {
  const tools = app.tools.map((tool) => tool.name);
  const runner = ports.runner?.kind ?? "rules";
  return {
    edition: "community",
    contract_version: CONTRACT_VERSION,
    mcp_revisions: [...MCP_REVISIONS],
    features: {
      vector: ports.embedder !== null,
      tasks: tools.includes("claim_task"),
      brief: true,
      closing_note: true,
      jobs: [...JOB_KINDS],
    },
    model_runners: runner === "rules" ? [] : [runner],
    tools,
    prompts: Object.keys(PROMPT_DESCRIPTIONS),
    degraded: ports.embedder === null ? ["no_model"] : [],
  };
}

/** Everything the Connect page shows, for a server reached at `origin`. The token is never among it. */
export function connectInfo(origin: string): ConnectInfo {
  const mcpUrl = `${origin}/mcp`;
  const command = (name: PromptName) => ({ name, description: PROMPT_DESCRIPTIONS[name] });
  return {
    mcp_url: mcpUrl,
    server_name: SERVER_NAME,
    token_env: TOKEN_ENV,
    token_command: `export ${TOKEN_ENV}="$(ukt token)"`,
    commands: { setup: command("setup"), activate: command("activate") },
    block: FENCED_BLOCK,
    harnesses: HARNESSES.map((harness) => ({
      id: harness.id,
      name: harness.name,
      instruction_file: harness.instructionFile,
      instruction_file_command: harness.instructionFileCommand,
      ...harness.connect(mcpUrl),
    })),
  };
}
