/** What a server would answer, typed by the contract, for the pages' tests. */
import {
  FENCED_BLOCK,
  LOCAL_BACKUPS,
  PROMPT_DESCRIPTIONS,
  TOOL_NAMES,
  TOKEN_ENV,
  type ApiError,
  type ApiFact,
  type ApiTask,
  type CapabilityDescriptor,
  type ConnectInfo,
  type DashboardSession,
  type FactDetail,
  type GroupList,
  type ProjectList,
  type RulingList,
  type TaskDetail,
  type TaskPage,
} from "@uketsugi/contracts";

export const PROJECT = "github.com/acme/billing";
const ORIGIN = "http://127.0.0.1:7410";
const MCP_URL = `${ORIGIN}/mcp`;

export const session: DashboardSession = {
  person: "Dana",
  csrf: "csrf-7f2c",
  expires_at: "2026-11-14T09:00:00Z",
};

export const capabilities: CapabilityDescriptor = {
  edition: "community",
  contract_version: "0.3.0",
  mcp_revisions: ["2025-06-18", "2025-11-25"],
  features: { vector: false, tasks: true, brief: true, closing_note: false, jobs: ["embed"] },
  model_runners: [],
  tools: [...TOOL_NAMES],
  prompts: ["setup", "activate"],
  degraded: ["no_model"],
  data: { delete_account: false, backups: LOCAL_BACKUPS },
  // What the open edition's server says, as the pages show it.
  dashboard: {
    sign_in: [
      "On the computer the server runs on, run `ukt ui` in a terminal: it opens the dashboard signed in, or prints a link that does.",
      "From any other computer, paste the dashboard key you were given.",
    ],
    key_form: true,
    token_command: `export ${TOKEN_ENV}="$(ukt token)"`,
    token_row: `read from the environment variable \`${TOKEN_ENV}\`; this page never shows the token itself. On the server's host, \`ukt token\` prints yours.`,
    shell_intro: `Run these in one terminal on the server's host. The first line puts your token in \`${TOKEN_ENV}\`, where the rest read it:`,
    shell_elsewhere: `On another machine, set \`${TOKEN_ENV}\` to the token you were given in place of the first line.`,
    token_change:
      "{harness} keeps the token it was added with. To give it another, after `ukt token --rotate` for one, first remove the server with `{remove}`, then run the lines above again.",
  },
};

/** What another edition, which signs a person in at a provider and has no key and no `ukt`, says of the token it gives. */
export const hostedWords = {
  sign_in: ["Open the service's address in your browser and sign in at your provider."],
  key_form: false,
  token_command: "hosted-sign-in",
  token_row: "given to your harness when it signs in; there is nothing to copy.",
  shell_intro: "Run these in a terminal, then sign in from the harness:",
  shell_elsewhere: "Run them on any machine you use.",
  token_change: "{harness} signs in again when it is told to: run `{remove}`, then the lines.",
};

export const hostedCapabilities: CapabilityDescriptor = {
  ...capabilities,
  edition: "hosted",
  dashboard: hostedWords,
  data: { delete_account: true, backups: "Backups are kept thirty days." },
};

/** What a server that needs no token from a harness on its own machine describes: the harness lines carry none. */
export const connect: ConnectInfo = {
  mcp_url: MCP_URL,
  server_name: "uketsugi",
  needs_token: false,
  token_env: TOKEN_ENV,
  token_command: `export ${TOKEN_ENV}="$(ukt token)"`,
  commands: {
    setup: { name: "setup", description: PROMPT_DESCRIPTIONS.setup },
    activate: { name: "activate", description: PROMPT_DESCRIPTIONS.activate },
  },
  block: FENCED_BLOCK,
  harnesses: [
    {
      id: "claude-code",
      name: "Claude Code",
      plugin: {
        install: `claude plugin install uketsugi --marketplace /opt/uketsugi/plugins --config url=${ORIGIN}`,
        remove: "claude plugin marketplace remove uketsugi",
        adds_server: true,
      },
      add: `claude mcp add --transport http --scope user uketsugi ${MCP_URL}`,
      add_kind: "command",
      remove: "claude mcp remove uketsugi -s user",
      setup: "/uketsugi:setup",
      activate: "/uketsugi:activate",
      known: "run here: Claude Code 2.1.325",
      instruction_file: "~/.claude/CLAUDE.md",
      instruction_file_command: 'echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/CLAUDE.md"',
    },
    {
      id: "antigravity",
      name: "Antigravity",
      plugin: {
        install: "agy plugin install /opt/uketsugi/plugins/antigravity",
        remove: "agy plugin uninstall uketsugi",
        adds_server: false,
      },
      add: `agy mcp add uketsugi ${MCP_URL}`,
      add_kind: "command",
      remove: "agy mcp remove uketsugi",
      known: "run here: Antigravity 1.5.9",
      instruction_file: "~/.gemini/GEMINI.md",
    },
    {
      id: "cursor",
      name: "Cursor",
      add: `"uketsugi": {"url": "${MCP_URL}"}`,
      add_kind: "file",
      add_where:
        'Cursor has no command that adds a server. In ~/.cursor/mcp.json, under "mcpServers", add:',
      known: "run here: Cursor's agent 2025.11.25",
    },
    {
      id: "other",
      name: "Another client",
      add: MCP_URL,
      add_kind: "url",
      note: "Any client that takes a remote MCP server by its URL.",
      known: "not established",
    },
  ],
};

/** What the same server describes to someone who must send a token: the lines read it from a variable. */
export const connectWithToken: ConnectInfo = {
  ...connect,
  needs_token: true,
  harnesses: connect.harnesses.map((harness) => ({
    ...harness,
    add:
      harness.id === "claude-code"
        ? `${harness.add} --header "Authorization: Bearer $${TOKEN_ENV}"`
        : harness.add,
  })),
};

export const projects: ProjectList = {
  projects: [
    {
      key: PROJECT,
      kind: "repository",
      name: null,
      names: [],
      facts: 41,
      treatment: "private",
      chosen: false,
    },
    {
      key: "me/q4-expenses",
      kind: "named",
      name: "Q4 expenses",
      names: [],
      facts: 1,
      treatment: "private",
      chosen: true,
    },
  ],
  sharing: true,
};

export const CLAIM = "Invoice webhooks retry five times with exponential backoff";

export const retries: ApiFact = {
  id: "0193-retries",
  project: PROJECT,
  audience: "shared",
  claim: CLAIM,
  detail: "The first retry is after 2 s; the sixth failure goes to the dead-letter queue.",
  question: "what is the retry policy for invoice webhooks",
  citations: [
    { ref: "services/billing/webhooks/retry.rs:41-88@9f3c2e1", kind: "file", class: "checkable" },
    {
      ref: "https://wiki.acme.example/runbooks/webhooks",
      kind: "web",
      class: "testimony",
      reason: "needs sign-in",
    },
  ],
  status: "confirmed",
  flags: [],
  trust: "reviewed",
  author: "Dana's Claude Code",
  from_session: null,
  own: true,
  redacted: false,
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-10T10:00:00Z",
  confirmed_at: "2026-11-12T10:00:00Z",
  superseded_by: null,
};

export const idempotency: ApiFact = {
  ...retries,
  id: "0193-idempotency",
  audience: "private",
  claim: "The idempotency key is generated in the request middleware",
  detail: null,
  question: null,
  citations: [{ ref: "9f3c2e1", kind: "commit", class: "checkable" }],
  status: "unconfirmed",
  flags: ["marked_stale"],
  trust: "unreviewed",
  confirmed_at: null,
};

export const retriesDetail: FactDetail = {
  fact: retries,
  confirmations: [
    {
      person: "Dana",
      by_author: false,
      at: "2026-11-12T10:00:00Z",
      checked: "read retry.rs",
      source_version: "9f3c2e1",
    },
  ],
  history: [
    { kind: "FactConfirmed", actor: "Dana", at: "2026-11-12T10:00:00Z" },
    { kind: "FactPublished", actor: "Dana's Claude Code", at: "2026-11-01T10:00:00Z" },
  ],
};

export const TASK = "Move webhook retries to the queue";
export const HANDOFF = "Left: switch the dunning job. Start in jobs/dunning.ts.";

/** Handed over by the reader's own agent, in a project they share. */
export const handedOff: ApiTask = {
  id: "0194-retries",
  project: PROJECT,
  title: TASK,
  state: "handed_off",
  version: 5,
  publisher: "you",
  audience: "shared",
  note: HANDOFF,
  note_kind: "handoff",
  note_by: "you",
  note_client: "claude-code",
  note_at: "2026-11-13T08:40:00Z",
  created_at: "2026-11-13T08:00:00Z",
  updated_at: "2026-11-13T08:40:00Z",
};

/** Another person's claim whose lease ran out: open again, and it says who held it. */
export const lapsed: ApiTask = {
  id: "0194-runbook",
  project: PROJECT,
  title: "Write the runbook",
  state: "open",
  lapsed: true,
  version: 2,
  publisher: "Lee",
  holder: "Lee",
  holder_client: "antigravity",
  lease_expires_at: "2026-11-13T07:00:00Z",
  audience: "shared",
  created_at: "2026-11-12T08:00:00Z",
  updated_at: "2026-11-13T06:45:00Z",
};

/** A step of the reader's own agent's plan, held under a lease that has not ended. */
export const held: ApiTask = {
  id: "0194-schema",
  project: "github.com/acme/ledger",
  title: "Step 1: read the schema",
  state: "claimed",
  tracked: true,
  version: 2,
  publisher: "you",
  holder: "you",
  holder_client: "claude-code",
  lease_expires_at: "2099-01-01T00:00:00Z",
  audience: "private",
  created_at: "2026-11-13T09:00:00Z",
  updated_at: "2026-11-13T09:00:00Z",
};

export const tasks: TaskPage = { tasks: [handedOff, lapsed, held], matched: 3 };

export const handedOffDetail: TaskDetail = {
  task: { ...handedOff, description: "Retries run inline today and block the worker." },
  notes: [
    {
      kind: "note",
      text: "Retry path moved.",
      author: "Lee",
      client: "antigravity",
      at: "2026-11-13T08:20:00Z",
    },
    {
      kind: "handoff",
      text: HANDOFF,
      author: "you",
      client: "claude-code",
      at: "2026-11-13T08:40:00Z",
    },
  ],
  history: [
    {
      event: "published",
      by: "you",
      client: "claude-code",
      session: "s-7f2c",
      at: "2026-11-13T08:00:00Z",
    },
    { event: "claimed", by: "Lee", client: "antigravity", at: "2026-11-13T08:05:00Z" },
    {
      event: "claimed",
      by: "you",
      client: "claude-code",
      session: "s-51d2",
      at: "2026-11-13T08:30:00Z",
      after: "lapsed",
    },
    {
      event: "handed_off",
      by: "you",
      client: "claude-code",
      session: "s-51d2",
      at: "2026-11-13T08:40:00Z",
    },
  ],
};

export const rulings: RulingList = {
  rulings: [
    {
      id: "r-merge",
      decision: "merge_duplicate",
      fact: idempotency.id,
      actor: "consolidate",
      runner: "rules",
      reasons: ["same_claim"],
      at: "2026-11-13T08:00:00Z",
      reverted_by: null,
      revertible: true,
    },
    {
      id: "r-redact",
      decision: "redact",
      fact: retries.id,
      actor: "Dana",
      reasons: ["person_asked"],
      at: "2026-11-12T08:00:00Z",
      reverted_by: null,
      revertible: false,
    },
  ],
};

export const unavailable: ApiError = {
  error: {
    code: "unavailable",
    what: "The store did not answer.",
    meaning: "Nothing was read and nothing was changed.",
    next: "Wait a moment, then try again.",
    retry: true,
  },
};

/** What the server answers a browser without a session, as it answers any request nobody signed. */
export const unauthorized: ApiError = {
  error: {
    code: "unauthorized",
    what: "Nobody is signed in on this request.",
    meaning: "The dashboard's session has ended, or the request carried no token the server knows.",
    next: "Sign in with your dashboard key on the sign-in page, ; if you run this server, you can also run `ukt ui` on its host and open the link it prints, and if someone else runs it, ask them for a key. A script sends a harness token as a bearer token.",
    retry: false,
  },
};

export const unknownKey: ApiError = {
  error: {
    code: "unauthorized",
    what: "That is not a dashboard key this server knows.",
    meaning: "Nobody was signed in. The token a harness sends does not sign a person in.",
    next: "Paste the dashboard key you were given with your invitation, whole.",
    retry: false,
  },
};

/** The groups of a server with two people: the one every organization has. */
export const groups: GroupList = {
  groups: [
    {
      name: "everyone",
      mine: true,
      members: [
        { id: "0197a000-0000-7000-8000-000000000001", name: "Ann" },
        { id: "0197a000-0000-7000-8000-000000000002", name: "Bo" },
      ],
    },
  ],
  people: [],
  administrator: false,
};
