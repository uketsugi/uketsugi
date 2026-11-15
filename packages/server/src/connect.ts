/**
 * What a client or the dashboard learns about this server before it uses it: the capability
 * descriptor, and the Connect page's set-up, per harness. Everything the server knows about one
 * harness is its row in `HARNESSES`. How each names and delivers the two commands is what the
 * experiments measured (5D stage 2, 5E): Claude Code lists a server's MCP prompts as commands;
 * Antigravity never asks a server for its prompts. Each has a plugin, a folder of files the
 * server ships (`plugins/`), and with it nobody runs set-up or places the block.
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

/** Claude Code, as its MCP client names itself: the harness whose hooks the server answers. */
export const CLAUDE_CODE = "claude-code";

/** The plugin's name in each harness, and the name of the marketplace Claude Code installs it from. */
export const PLUGIN_NAME = SERVER_NAME;

/**
 * Where the person who asks gets the plugins from: the folder of them on this machine, for
 * someone on the server's host, or this server, which serves each as a zip under `url`.
 */
export type PluginsFrom = { readonly folder: string } | { readonly url: string };

type Plugin = NonNullable<ConnectHarness["plugin"]>;

interface Harness {
  /** The name its MCP client gives on a call, and its key on the Connect page. */
  readonly id: string;
  readonly name: string;
  /** What adds the server where it takes no token: a shell command, or the URL itself. Slots: `{name}`, `{url}`. */
  readonly add: string;
  /** What adds it where every caller must send a token. Slots as `add`, and `{token}`: the variable that holds it. */
  readonly addWithToken: string;
  readonly addKind: "command" | "url";
  /** What takes the server out again, for a command. */
  readonly remove?: string;
  /** What its person types to run set-up and to use memory in one session; absent where it offers no server commands. */
  readonly setup?: string;
  readonly activate?: string;
  /** One line on anything it does differently, and one said only where this server needs a token. */
  readonly note?: string;
  readonly tokenNote?: string;
  /** How this row is known: run here on a named version, a dated documentation page, or not established. */
  readonly known: string;
  /** The user-level instruction file the block goes in, where the server knows it: the place it usually is. */
  readonly instructionFile?: string;
  /**
   * A shell command that prints that file's path in the harness's own environment, for a harness
   * whose file is not always in the usual place. Its agent runs it instead of working the path out.
   */
  readonly instructionFileCommand?: string;
  /** Where its own conversation id arrives in a request's `_meta`, if it sends one. */
  readonly conversationIdKey?: string;
  /**
   * Where the id of a tool call arrives in a request's `_meta`, for a harness whose hook says
   * which conversation each call belongs to before the call is made (`tool-uses.ts`).
   */
  readonly toolUseIdKey?: string;
  /**
   * How the person installs its plugin for the server at `origin`, with the step that gives it a
   * token only where the server needs one; null where it has none, or cannot fetch it from where
   * the person would have to.
   */
  plugin(origin: string, from: PluginsFrom, needsToken: boolean): Plugin | null;
}

/** A row's line with its slots filled for the server at `mcpUrl`. */
function filled(line: string, mcpUrl: string): string {
  return line
    .replaceAll("{name}", SERVER_NAME)
    .replaceAll("{url}", mcpUrl)
    .replaceAll("{token}", `$${TOKEN_ENV}`);
}

/** A word of a shell line: as it is where a shell reads it as one word, else in single quotes. */
export function word(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

/** A harness's plugin folder on the person's machine, and the lines that put it there first, if any. */
function folderOf(from: PluginsFrom, plugin: string): { folder: string; fetch: string } {
  if ("folder" in from) return { folder: word(`${from.folder}/${plugin}`), fetch: "" };
  const folder = `${PLUGIN_NAME}-${plugin}`;
  const zip = `${folder}.zip`;
  return {
    folder,
    fetch: `curl -fsSL ${from.url}/${plugin}.zip -o ${zip}\nunzip -o ${zip} -d ${folder}\n`,
  };
}

const HARNESSES: readonly Harness[] = [
  {
    id: CLAUDE_CODE,
    name: "Claude Code",
    add: "claude mcp add --transport http --scope user {name} {url}",
    addWithToken:
      'claude mcp add --transport http --scope user {name} {url} --header "Authorization: Bearer {token}"',
    addKind: "command",
    remove: "claude mcp remove {name} -s user",
    // An interactive session lists a server's prompts as /{name}:setup and /{name}:activate
    // (`ACCEPTANCE-1.md`, `recommendations-round-2.md`); `claude -p` takes them only as the
    // mcp__ form, which the note gives.
    setup: "/{name}:setup",
    activate: "/{name}:activate",
    note: `\`claude -p\` refuses every call to the server until its tools are allowed: add --allowedTools mcp__{name} (with the plugin, mcp__plugin_${PLUGIN_NAME}_${SERVER_NAME}). There its commands are /mcp__{name}__setup and /mcp__{name}__activate. Type set-up in an interactive session: with \`claude -p\` nobody is there to allow the edit of the file.`,
    known:
      "run here: Claude Code 2.1.325 takes the address alone from a server that needs no token and reports it connected; the commands were not typed in a session",
    instructionFile: "~/.claude/CLAUDE.md",
    // Claude Code keeps its configuration, this file included, in the folder CLAUDE_CONFIG_DIR
    // names where that is set, and under the home it runs in, whichever that is.
    instructionFileCommand: 'echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/CLAUDE.md"',
    toolUseIdKey: "claudecode/toolUseId",
    // The plugin brings the server, the block and the brief at the start of every session, and
    // leaves each session's note. Claude Code fetches a plugin from a server only as a zip over
    // TLS; from a folder it reads the files where they are. The token goes in on standard input:
    // on a command line every user of the machine could read it.
    plugin: (origin, from, needsToken) => {
      if ("url" in from && !from.url.startsWith("https://")) return null;
      const marketplace = "folder" in from ? word(from.folder) : `${from.url}/marketplace.json`;
      const id = `${PLUGIN_NAME}@${PLUGIN_NAME}`;
      const give = `printf '{"token":"%s"}' "$${TOKEN_ENV}" | claude plugin configure ${id} --values-stdin`;
      return {
        install: [
          `claude plugin install ${PLUGIN_NAME} --marketplace ${marketplace} --config url=${origin}`,
          ...(needsToken ? [give] : []),
        ].join("\n"),
        remove: `claude plugin marketplace remove ${PLUGIN_NAME}`,
        adds_server: true,
      };
    },
  },
  {
    id: "antigravity",
    name: "Antigravity",
    add: "agy mcp add {name} {url}",
    // Antigravity writes the file that holds the token for every account of the machine to
    // read, so the second line closes it. It stays closed until Antigravity next rewrites it.
    addWithToken:
      'agy mcp add --header "Authorization: Bearer {token}" {name} {url}\nchmod 600 ~/.gemini/config/mcp_config.json',
    addKind: "command",
    remove: "agy mcp remove {name}",
    // It lists no server's prompts, so there is nothing to type: the block is put in the file by hand.
    known:
      "run here: Antigravity 1.5.9 takes the address with `agy mcp add`; that it then connects is not shown",
    instructionFile: "~/.gemini/GEMINI.md",
    conversationIdKey: "antigravity.google/conversation_id",
    // The plugin is the block, as a rule that is always on. Antigravity installs one from a folder.
    plugin: (_origin, from) => {
      const { folder, fetch } = folderOf(from, "antigravity");
      return {
        install: `${fetch}agy plugin install ${folder}`,
        remove: `agy plugin uninstall ${PLUGIN_NAME}`,
        adds_server: false,
      };
    },
  },
  {
    id: "other",
    name: "Another client",
    add: "{url}",
    addWithToken: "{url}",
    addKind: "url",
    note: "Any client that takes a remote MCP server by its URL: add this one under the name {name}.",
    tokenNote: 'Send the token as the header "Authorization: Bearer" and the token.',
    known: "not established: no other client was tried",
    plugin: () => null,
  },
];

/** Where a client's own conversation id may arrive in a request's `_meta`: each harness's key. */
export const CONVERSATION_ID_KEYS = HARNESSES.flatMap((harness) =>
  harness.conversationIdKey === undefined ? [] : [harness.conversationIdKey],
);

/** The harnesses whose hooks say which conversation each of their calls belongs to. */
const SPOKEN_FOR = HARNESSES.flatMap((harness) =>
  harness.toolUseIdKey === undefined ? [] : [{ id: harness.id, key: harness.toolUseIdKey }],
);

/**
 * What a tool call gives a hook's word to be found by: the call's own id, where the request
 * carries one under a harness's key, whatever the client calls itself; null for a call that
 * carries none from a harness whose hooks speak for its calls; undefined for any other call, which
 * no hook speaks for.
 */
export function toolUseOf(
  clientName: string,
  meta: Readonly<Record<string, unknown>>,
): string | null | undefined {
  const ids = SPOKEN_FOR.map(({ key }) => meta[key]);
  const id = ids.find((value) => typeof value === "string" && value !== "");
  if (typeof id === "string") return id;
  return SPOKEN_FOR.some((harness) => harness.id === clientName) ? null : undefined;
}

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

/**
 * Everything the Connect page shows, for a server reached at `origin` by someone who would get
 * its plugins from `plugins`; null where the server has none to give. `needsToken` says whether
 * what that person's harness is added with carries a token: the lines differ. The token is never
 * among it.
 */
export function connectInfo(
  origin: string,
  plugins: PluginsFrom | null,
  needsToken: boolean,
): ConnectInfo {
  const mcpUrl = `${origin}/mcp`;
  const command = (name: PromptName) => ({ name, description: PROMPT_DESCRIPTIONS[name] });
  const line = (text: string | undefined): string | undefined =>
    text === undefined ? undefined : filled(text, mcpUrl);
  return {
    mcp_url: mcpUrl,
    server_name: SERVER_NAME,
    needs_token: needsToken,
    token_env: TOKEN_ENV,
    token_command: `export ${TOKEN_ENV}="$(ukt token)"`,
    commands: { setup: command("setup"), activate: command("activate") },
    block: FENCED_BLOCK,
    harnesses: HARNESSES.map((harness) => ({
      id: harness.id,
      name: harness.name,
      plugin: (plugins === null ? null : harness.plugin(origin, plugins, needsToken)) ?? undefined,
      add: filled(needsToken ? harness.addWithToken : harness.add, mcpUrl),
      add_kind: harness.addKind,
      remove: line(harness.remove),
      setup: line(harness.setup),
      activate: line(harness.activate),
      note: line(
        [harness.note, needsToken ? harness.tokenNote : undefined]
          .filter((text) => text !== undefined)
          .join(" ") || undefined,
      ),
      known: harness.known,
      instruction_file: harness.instructionFile,
      instruction_file_command: harness.instructionFileCommand,
    })),
  };
}
