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
  SERVER_NAME,
  TOKEN_ENV,
  type CapabilityDescriptor,
  type ConnectHarness,
  type ConnectInfo,
  type PromptName,
} from "@uketsugi/contracts";
import { JOB_KINDS, type App, type AppPorts } from "@uketsugi/core";

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

/**
 * A harness's plugin, as the lines that install it and take it out again. Slots, besides the
 * ones every line has: `{source}`, where the harness installs it from, and `{origin}`, the
 * server's address.
 */
interface PluginRow {
  /**
   * How the harness takes it: from the marketplace file of the folder of plugins (served, with
   * each plugin as a zip, from an address), or as one plugin's folder, which from an address is
   * fetched as its zip and unpacked first.
   */
  readonly source: "marketplace" | { readonly folder: string };
  readonly install: string;
  /** The line that gives it the token, added where the server needs one. */
  readonly giveToken?: string;
  readonly remove: string;
  /** Whether installing it adds the server too. */
  readonly addsServer: boolean;
  /** Whether the harness fetches it from an address only over TLS. */
  readonly httpsOnly: boolean;
}

interface Harness {
  /** The name its MCP client gives on a call, and its key on the Connect page. */
  readonly id: string;
  readonly name: string;
  /** What adds the server where it takes no token: a shell command, the URL itself, or the text of a file. Slots: `{name}`, `{url}`. */
  readonly add: string;
  /**
   * What adds it where every caller must send a token. Slots as `add`, and the variable that
   * holds the token: `{token}` where a shell reads it, `{tokenVar}` its name alone.
   */
  readonly addWithToken: string;
  readonly addKind: "command" | "url" | "file";
  /** For a file: which file the text goes in and where in it, as a sentence that `add` follows. */
  readonly addWhere?: string;
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
  /** Its plugin, where it has one. */
  readonly plugin?: PluginRow;
}

type Slots = Readonly<Record<string, string>>;

/** A row's line with every slot it names filled, in one pass, so that no filled value is read for slots. */
function filled(line: string, slots: Slots): string {
  return line.replace(/\{(\w+)\}/g, (slot, key: string) => slots[key] ?? slot);
}

/**
 * The slots every line of a row has, for the server at `mcpUrl`: the server's name, the plugin's,
 * the server's MCP address, and the variable that holds the token as a shell reads it and by name.
 */
function slotsOf(mcpUrl: string): Slots {
  return {
    name: SERVER_NAME,
    plugin: PLUGIN_NAME,
    url: mcpUrl,
    token: `$${TOKEN_ENV}`,
    tokenVar: TOKEN_ENV,
  };
}

/** A word of a shell line: as it is where a shell reads it as one word, else in single quotes. */
export function word(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Where a plugin is installed from on the person's machine, and the lines that put it there first. */
function sourceOf(row: PluginRow, from: PluginsFrom): { source: string; fetch: string[] } {
  if (row.source === "marketplace") {
    const source = "folder" in from ? word(from.folder) : `${from.url}/marketplace.json`;
    return { source, fetch: [] };
  }
  const plugin = row.source.folder;
  if ("folder" in from) return { source: word(`${from.folder}/${plugin}`), fetch: [] };
  const folder = `${PLUGIN_NAME}-${plugin}`;
  const zip = `${folder}.zip`;
  const fetch = [`curl -fsSL ${from.url}/${plugin}.zip -o ${zip}`, `unzip -o ${zip} -d ${folder}`];
  return { source: folder, fetch };
}

/**
 * How the person installs a plugin for the server at `origin`, with the step that gives it a token
 * only where the server needs one; null where the harness cannot fetch it from where the person
 * would have to.
 */
function pluginOf(
  row: PluginRow,
  slots: Slots,
  from: PluginsFrom,
  needsToken: boolean,
): Plugin | null {
  if ("url" in from && row.httpsOnly && !from.url.startsWith("https://")) return null;
  const { source, fetch } = sourceOf(row, from);
  const line = (text: string) => filled(text, { ...slots, source });
  const give = needsToken && row.giveToken !== undefined ? [line(row.giveToken)] : [];
  return {
    install: [...fetch, line(row.install), ...give].join("\n"),
    remove: line(row.remove),
    adds_server: row.addsServer,
  };
}

export const HARNESSES: readonly Harness[] = [
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
    note: `\`claude -p\` refuses every call to the server until its tools are allowed: add --allowedTools mcp__{name} (with the plugin, mcp__plugin_{plugin}_{name}). There its commands are /mcp__{name}__setup and /mcp__{name}__activate. Type set-up in an interactive session: with \`claude -p\` nobody is there to allow the edit of the file.`,
    known:
      "run here: Claude Code 2.1.325 takes the address alone from a server that needs no token, and both commands were typed in a session",
    instructionFile: "~/.claude/CLAUDE.md",
    // Claude Code keeps its configuration, this file included, in the folder CLAUDE_CONFIG_DIR
    // names where that is set, and under the home it runs in, whichever that is.
    instructionFileCommand: 'echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/CLAUDE.md"',
    toolUseIdKey: "claudecode/toolUseId",
    // The plugin brings the server, the block and the brief at the start of every session, and
    // leaves each session's note. Claude Code fetches a plugin from a server only as a zip over
    // TLS; from a folder it reads the files where they are. The token goes in on standard input:
    // on a command line every user of the machine could read it.
    plugin: {
      source: "marketplace",
      install: "claude plugin install {plugin} --marketplace {source} --config url={origin}",
      giveToken: `printf '{"token":"%s"}' "{token}" | claude plugin configure {plugin}@{plugin} --values-stdin`,
      remove: "claude plugin marketplace remove {plugin}",
      addsServer: true,
      httpsOnly: true,
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
    note: "`agy mcp list` says `enabled` of a server it could not reach or that refused it; the dashboard's Connect page lists the sessions that reached the server.",
    known:
      "run here: Antigravity 1.5.9 takes the address with `agy mcp add`, and a session then called the server's tools",
    instructionFile: "~/.gemini/GEMINI.md",
    conversationIdKey: "antigravity.google/conversation_id",
    // The plugin is the block, as a rule that is always on. Antigravity installs one from a folder.
    plugin: {
      source: { folder: "antigravity" },
      install: "agy plugin install {source}",
      remove: "agy plugin uninstall {plugin}",
      addsServer: false,
      httpsOnly: false,
    },
  },
  {
    id: "codex",
    name: "Codex",
    add: "codex mcp add {name} --url {url}",
    // Codex is told the name of the variable and reads the token from it each time it starts.
    addWithToken: "codex mcp add {name} --url {url} --bearer-token-env-var {tokenVar}",
    addKind: "command",
    remove: "codex mcp remove {name}",
    known:
      "run here: Codex 0.166.0 stores the address with `codex mcp add` and lists a server that needs no token as enabled; no session was started, so whether it offers the server's commands and which file it reads are not established",
  },
  {
    id: "vscode",
    name: "VS Code",
    add: `code --add-mcp '{"name":"{name}","type":"http","url":"{url}"}'`,
    // In double quotes, so that the shell puts the token in.
    addWithToken: String.raw`code --add-mcp "{\"name\":\"{name}\",\"type\":\"http\",\"url\":\"{url}\",\"headers\":{\"Authorization\":\"Bearer {token}\"}}"`,
    addKind: "command",
    known:
      "run here: VS Code 1.146.0 adds the server to its user profile with `code --add-mcp`; the line that carries a token was not run, and no session was started",
  },
  {
    id: "cursor",
    name: "Cursor",
    add: '"{name}": {"url": "{url}"}',
    addWithToken: '"{name}": {"url": "{url}", "headers": {"Authorization": "Bearer <your token>"}}',
    addKind: "file",
    addWhere:
      'Cursor has no command that adds a server. In ~/.cursor/mcp.json, under "mcpServers", add:',
    note: "Its agent asks you to approve the server before it uses it.",
    tokenNote: "Put your token in place of <your token>; that line was not run here.",
    known:
      "run here: Cursor's agent 2025.11.25 reads the server from ~/.cursor/mcp.json and asks for it to be approved; no session was started",
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

/** The descriptor of this server as it is composed now, for the edition of that name. */
export function capabilityDescriptor(
  edition: string,
  app: App,
  ports: Pick<AppPorts, "embedder" | "runner">,
): CapabilityDescriptor {
  const tools = app.tools.map((tool) => tool.name);
  const runner = ports.runner?.kind ?? "rules";
  return {
    edition,
    contract_version: CONTRACT_VERSION,
    mcp_revisions: [...MCP_REVISIONS],
    features: {
      vector: ports.embedder !== null,
      tasks: tools.includes("claim_task"),
      brief: true,
      closing_note: true,
      // The reading of sessions by a model is a job of a server that has one.
      jobs: JOB_KINDS.filter((kind) => kind !== "digest" || runner !== "rules"),
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
  const slots = { ...slotsOf(mcpUrl), origin };
  const command = (name: PromptName) => ({ name, description: PROMPT_DESCRIPTIONS[name] });
  const line = (text: string | undefined): string | undefined =>
    text === undefined ? undefined : filled(text, slots);
  const plugin = (row: PluginRow | undefined) =>
    row === undefined || plugins === null
      ? undefined
      : (pluginOf(row, slots, plugins, needsToken) ?? undefined);
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
      plugin: plugin(harness.plugin),
      add: filled(needsToken ? harness.addWithToken : harness.add, slots),
      add_kind: harness.addKind,
      add_where: harness.addWhere,
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
