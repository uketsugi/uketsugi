// Generated from contract.schema.json by scripts/generate-types.ts. Do not edit.

/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "errorCode".
 */
export type ErrorCode =
  | "project_required"
  | "invalid_input"
  | "not_found"
  | "forbidden"
  | "unsupported"
  | "unavailable"
  | "internal"
  | "lease_held"
  | "conflict"
  | "unauthorized";
export type SearchFactsResult = Envelope & {
  /**
   * How many facts matched.
   */
  matched: number;
  /**
   * How many of them this result shows.
   */
  shown: number;
  confidence: Confidence;
  facts: Fact[];
  /**
   * What the text leads with when no fact is shown, or when none shown is a confident match.
   */
  message?: string;
  /**
   * The ranking's reasoning, on request.
   */
  explain?: {
    [k: string]: unknown;
  };
};
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "taskState".
 */
export type TaskState = "open" | "claimed" | "handed_off" | "done";
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "trust".
 */
export type Trust = "reviewed" | "unreviewed";
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "confidence".
 */
export type Confidence = "strong" | "low";
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "citationClass".
 */
export type CitationClass = "checkable" | "testimony";
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "status".
 */
export type Status = "unconfirmed" | "confirmed" | "superseded";
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "flagKind".
 */
export type FlagKind =
  "possible_duplicate" | "possible_contradiction" | "source_changed" | "marked_stale";
export type PublishFactResult = Envelope & {
  id: string;
  status: Status;
  /**
   * False when the caller's same claim was already stored and is returned.
   */
  created: boolean;
  citations: Citation[];
  /**
   * Near-identical facts already stored: confirm one of them in place of this.
   */
  similar?: {
    id: string;
    claim: string;
  }[];
  supersedes?: string;
  redacted?: Redacted;
  /**
   * Who can see the fact as it now stands. Only on a server with several people.
   */
  audience?: "private" | "shared";
  /**
   * With `audience: private`, when the fact is the caller's own.
   */
  private_because?: "project" | "no_source" | "cites_private" | "merged_word";
};
/**
 * What the scanner replaced before anything was stored: the field and the rule that matched, never the text.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "redacted".
 */
export type Redacted = {
  field: string;
  rule: string;
}[];
export type UpdateFactResult = Envelope & {
  id: string;
  status: Status;
  flags: FlagKind[];
  citations?: Citation[];
  redacted?: Redacted;
  /**
   * Who can see the fact as it now stands. Only on a server with several people.
   */
  audience?: "private" | "shared";
  /**
   * With `audience: private`, when the fact is the caller's own.
   */
  private_because?: "project" | "no_source" | "cites_private" | "merged_word";
};
export type SearchTasksResult = Envelope & {
  /**
   * How many tasks matched.
   */
  matched: number;
  /**
   * How many of them this result shows.
   */
  shown: number;
  tasks: Task[];
  /**
   * With id: the task's notes, oldest first.
   */
  notes?: TaskNote[];
  /**
   * With id: who published, claimed, released and finished the task, oldest first.
   */
  history?: TaskEvent[];
  /**
   * The reply when no task is shown.
   */
  message?: string;
};
export type PublishTaskResult = Envelope & {
  task: Task;
  /**
   * False when your unfinished task of the same title already existed and is returned.
   */
  created: boolean;
  /**
   * With claim: the lease to pass to update_task.
   */
  lease?: string;
};
export type ClaimTaskResult = Envelope & {
  task: Task;
  /**
   * The lease to pass to update_task.
   */
  lease: string;
  /**
   * True when the call passed the lease it already held, and that lease was renewed.
   */
  renewed: boolean;
  /**
   * The task's latest notes, oldest first: where the work stands.
   */
  notes: TaskNote[];
};
export type UpdateTaskResult = Envelope & {
  task: Task;
  /**
   * False when the change was already applied and nothing was done.
   */
  changed: boolean;
};
/**
 * Who can see a record on a server with several people: `shared`, everyone on it; `private`, only the person it belongs to.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "audience".
 */
export type Audience = "private" | "shared";
/**
 * A task as the dashboard shows it: what a tool result carries of it, with its project and who sees it.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "apiTask".
 */
export type ApiTask = Task & {
  project: string;
  audience: Audience;
  /**
   * When it was published. ISO 8601, UTC.
   */
  created_at: string;
};
/**
 * Why a fact is its author's alone on a server with several people. `project`: its project is private. In a project its person shares: `no_source`, none of its citations is checkable; `cites_private`, it cites a fact of its author's that others cannot see; `merged_word`, a duplicate merged into it has no checkable citation and would be shown with it.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "privateBecause".
 */
export type PrivateBecause = "project" | "no_source" | "cites_private" | "merged_word";

export interface ContractTypes {
  ToolError?: ToolError;
  SearchFactsInput?: SearchFactsInput;
  PublishFactInput?: PublishFactInput;
  UpdateFactInput?: UpdateFactInput;
  SearchTasksInput?: SearchTasksInput;
  PublishTaskInput?: PublishTaskInput;
  ClaimTaskInput?: ClaimTaskInput;
  UpdateTaskInput?: UpdateTaskInput;
  SearchFactsResult?: SearchFactsResult;
  PublishFactResult?: PublishFactResult;
  UpdateFactResult?: UpdateFactResult;
  SearchTasksResult?: SearchTasksResult;
  PublishTaskResult?: PublishTaskResult;
  ClaimTaskResult?: ClaimTaskResult;
  UpdateTaskResult?: UpdateTaskResult;
  FactListParams?: FactListParams;
  TaskListParams?: TaskListParams;
  ActivityParams?: ActivityParams;
  ExportParams?: ExportParams;
  HostProofParams?: HostProofParams;
  NewProjectRequest?: NewProjectRequest;
  ClaudeCodeHook?: ClaudeCodeHook;
  ProjectChoiceRequest?: ProjectChoiceRequest;
  SignInRequest?: SignInRequest;
  InviteRequest?: InviteRequest;
  DashboardSession?: DashboardSession;
  HostProof?: HostProof;
  SignInCode?: SignInCode;
  CapabilityDescriptor?: CapabilityDescriptor;
  ConnectInfo?: ConnectInfo;
  FactPage?: FactPage;
  FactDetail?: FactDetail;
  RedactResult?: RedactResult;
  TaskPage?: TaskPage;
  TaskDetail?: TaskDetail;
  RulingList?: RulingList;
  RevertResult?: RevertResult;
  ActivityReport?: ActivityReport;
  ProjectList?: ProjectList;
  ClaudeCodeHookOutput?: ClaudeCodeHookOutput;
  ProjectChoice?: ProjectChoice;
  PeopleList?: PeopleList;
  Invitation?: Invitation;
  TokenRevoked?: TokenRevoked;
}
export interface ToolError {
  error: {
    code: ErrorCode;
    /**
     * What happened.
     */
    what: string;
    /**
     * What it means.
     */
    meaning: string;
    /**
     * What to do next.
     */
    next: string;
    /**
     * Whether a retry can help.
     */
    retry: boolean;
    details?: {
      [k: string]: unknown;
    };
  };
}
export interface SearchFactsInput {
  /**
   * This repository's origin remote as host/owner/name, for example github.com/acme/api. Run `git remote get-url origin` once and reuse it.
   */
  project: string;
  query?: string;
  /**
   * One fact by its id, in place of a query. A superseded id also names the live fact.
   */
  id?: string;
  /**
   * Adds the ranking's reasoning for the facts returned.
   */
  explain?: boolean;
  /**
   * The most facts to return.
   */
  limit: number;
}
export interface PublishFactInput {
  /**
   * This repository's origin remote as host/owner/name, for example github.com/acme/api. Run `git remote get-url origin` once and reuse it.
   */
  project: string;
  claim: string;
  /**
   * Where the claim comes from, at least one. Each is a string (`path:lines`, `path:lines@commit`, a commit or a URL) or an object. A reference anyone can open (a repository item, a public web page) is checkable. One that needs sign-in is kept as testimony.
   *
   * @minItems 1
   */
  citations: (
    | string
    | {
        kind:
          | "file"
          | "commit"
          | "pull_request"
          | "issue"
          | "web"
          | "fact"
          | "observation"
          | "document"
          | "person";
        repo?: string;
        path?: string;
        lines?: string;
        commit?: string;
        number?: number;
        url?: string;
        quote?: string;
        fact?: string;
        text?: string;
        title?: string;
        who?: string;
        at?: string;
      }
  )[];
  detail?: string;
  question?: string;
  /**
   * The id of your own fact that this one corrects.
   */
  supersedes?: string;
}
export interface UpdateFactInput {
  /**
   * This repository's origin remote as host/owner/name, for example github.com/acme/api. Run `git remote get-url origin` once and reuse it.
   */
  project: string;
  id: string;
  claim?: string;
  detail?: string;
  /**
   * Replaces the fact's citations. Each is a string (`path:lines`, `path:lines@commit`, a commit or a URL) or an object, as for publish_fact.
   *
   * @minItems 1
   */
  citations?: (
    | string
    | {
        [k: string]: unknown;
      }
  )[];
  /**
   * Records that you checked the fact against its source and it holds.
   */
  confirm?: {
    /**
     * What you checked.
     */
    checked: string;
    /**
     * The version of the source you checked against: a commit, for a repository item.
     */
    source_version?: string;
  };
  /**
   * Marks the fact as doubtful: out of date, or contradicted by what you found.
   */
  flag?: "stale" | "contradiction";
}
export interface SearchTasksInput {
  /**
   * This repository's origin remote as host/owner/name, for example github.com/acme/api. Run `git remote get-url origin` once and reuse it.
   */
  project: string;
  /**
   * One task by its id, with its notes, its holder and who published and held it.
   */
  id?: string;
  /**
   * Only tasks in this state. Without it, every task that is not done.
   */
  status?: "open" | "claimed" | "handed_off" | "done";
  /**
   * Only tasks you published or hold.
   */
  mine?: boolean;
  /**
   * The most tasks to return.
   */
  limit: number;
}
export interface PublishTaskInput {
  /**
   * This repository's origin remote as host/owner/name, for example github.com/acme/api. Run `git remote get-url origin` once and reuse it.
   */
  project: string;
  /**
   * The work, in one line.
   */
  title: string;
  /**
   * What is to be done.
   */
  description?: string;
  /**
   * Takes the task in the same call and returns its lease.
   */
  claim?: boolean;
  /**
   * Marks a step of your own plan. A tracked task is private to the person.
   */
  tracked?: boolean;
}
export interface ClaimTaskInput {
  /**
   * This repository's origin remote as host/owner/name, for example github.com/acme/api. Run `git remote get-url origin` once and reuse it.
   */
  project: string;
  id: string;
  /**
   * The lease you already hold on this task: the claim renews it and returns the same lease.
   */
  lease?: string;
  /**
   * Takes the task from a lease one of your own sessions still holds; that lease then stops working. For when that session is gone or the person asks.
   */
  take_over?: boolean;
}
export interface UpdateTaskInput {
  /**
   * This repository's origin remote as host/owner/name, for example github.com/acme/api. Run `git remote get-url origin` once and reuse it.
   */
  project: string;
  id: string;
  /**
   * The lease claim_task returned. Every change needs it, and every call that passes it renews it.
   */
  lease?: string;
  /**
   * A note at a checkpoint. With state released it is the handoff note for whoever takes the task next.
   */
  note?: string;
  /**
   * done finishes the task. released frees the lease: with a note the task is handed off, without one it is open again.
   */
  state?: "done" | "released";
  /**
   * The version of the task this change was made against. A change already applied changes nothing; one against an older version is refused.
   */
  version?: number;
}
/**
 * What every result carries.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "envelope".
 */
export interface Envelope {
  /**
   * The project, in its canonical spelling.
   */
  project: string;
  /**
   * How the caller's person treats this project: `used here, private` keeps what they publish here theirs alone; `used here, shared` shows what they publish here that others can check to everyone on the server. Only the person chooses.
   */
  treatment: string;
  /**
   * A display id for the inferred session.
   */
  session: string;
  /**
   * What is incomplete in this result, for example `no_model`.
   */
  degraded: string[];
  brief?: Brief;
}
/**
 * What a session starts from: data from memory, never instructions. The server attaches it to the first result of each inferred session, and bounds its size.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "brief".
 */
export interface Brief {
  /**
   * What the person has not yet decided about this project, and where they decide it. Absent once they have, and on a server with one person.
   */
  notice?: string;
  /**
   * Tasks whose lease the caller's person holds.
   */
  held: Task[];
  /**
   * The project's open and handed-off tasks, each with its latest note.
   */
  tasks: Task[];
  /**
   * Claimed tasks whose lease ran out: nobody is working on them.
   */
  lapsed: Task[];
  /**
   * How the person's previous session in this project ended.
   */
  last_session?: {
    session: string;
    client: string;
    /**
     * True when its final note was written at or after its last call.
     */
    closed: boolean;
    /**
     * True when it has not closed and called within the idle gap: it may still be running.
     */
    open: boolean;
    calls: number;
    /**
     * ISO 8601, UTC.
     */
    last_call_at: string;
    /**
     * Its latest note: the final one when it closed, otherwise the last progress note it left.
     */
    note?: string;
    /**
     * ISO 8601, UTC.
     */
    note_at?: string;
    /**
     * Facts the person published while it ran.
     */
    published: BriefFact[];
  };
  /**
   * The project's most relevant standing facts, one line each.
   */
  facts: BriefFact[];
  /**
   * How many facts the project holds; `facts` shows some of them.
   */
  fact_count: number;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "task".
 */
export interface Task {
  id: string;
  title: string;
  description?: string;
  state: TaskState;
  version: number;
  /**
   * A step of an agent's own plan, private to the person.
   */
  tracked?: boolean;
  /**
   * Who holds the lease while the task is claimed, or held it when the lease lapsed.
   */
  holder?: string;
  /**
   * The latest note: the handoff note of a handed-off task. A list shows its beginning.
   */
  note?: string;
  /**
   * Who published it.
   */
  publisher?: string;
  /**
   * The client the lease was taken from, for example claude-code.
   */
  holder_client?: string;
  /**
   * The lease was taken in this session.
   */
  held_by_this_session?: boolean;
  /**
   * When the lease ends unless its holder renews it. ISO 8601, UTC.
   */
  lease_expires_at?: string;
  /**
   * The lease ran out without a release: the task is open and can be claimed.
   */
  lapsed?: boolean;
  note_kind?: "note" | "handoff";
  /**
   * Who wrote the latest note.
   */
  note_by?: string;
  /**
   * The client the latest note was written from.
   */
  note_client?: string;
  /**
   * ISO 8601, UTC.
   */
  note_at?: string;
  /**
   * ISO 8601, UTC.
   */
  updated_at: string;
}
/**
 * A fact as a brief lists it. search_facts with its id returns the whole fact.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "briefFact".
 */
export interface BriefFact {
  id: string;
  claim: string;
  trust: Trust;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "fact".
 */
export interface Fact {
  id: string;
  claim: string;
  detail?: string;
  question?: string;
  citations: Citation[];
  status: Status;
  flags: FlagKind[];
  trust: Trust;
  /**
   * Who wrote it: `you` for the caller's own person, otherwise the person's name.
   */
  author: string;
  /**
   * Only on a server with several people.
   */
  audience?: "private" | "shared";
  /**
   * ISO 8601, UTC.
   */
  updated_at: string;
  /**
   * The newest confirmation, ISO 8601.
   */
  confirmed_at?: string;
  /**
   * The live fact at the head of the chain.
   */
  superseded_by?: string;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "citation".
 */
export interface Citation {
  /**
   * The citation in one line.
   */
  ref: string;
  kind: string;
  class: CitationClass;
  /**
   * Why a citation is testimony.
   */
  reason?: string;
}
/**
 * A note on a task. Notes are only ever added.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "taskNote".
 */
export interface TaskNote {
  kind: "note" | "handoff";
  text: string;
  author: string;
  /**
   * The client it was done from, for example claude-code.
   */
  client?: string;
  /**
   * ISO 8601, UTC.
   */
  at: string;
}
/**
 * One step of a task's life, read back from the log.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "taskEvent".
 */
export interface TaskEvent {
  event: "published" | "claimed" | "released" | "handed_off" | "done";
  by: string;
  /**
   * The client it was done from, for example claude-code.
   */
  client?: string;
  /**
   * The display id of the session it happened in.
   */
  session?: string;
  /**
   * ISO 8601, UTC.
   */
  at: string;
  /**
   * On a claim: the lease before it had lapsed, or was taken over.
   */
  after?: "lapsed" | "take_over";
}
/**
 * `GET /api/facts` query.
 */
export interface FactListParams {
  /**
   * Only this project's facts, by its canonical key.
   */
  project?: string;
  /**
   * A search: needs `project`. Without it the list is newest first.
   */
  q?: string;
  /**
   * `next` of the page before.
   */
  cursor?: string;
  /**
   * The most facts on a page.
   */
  limit: number;
}
/**
 * `GET /api/tasks` query.
 */
export interface TaskListParams {
  /**
   * Only this project's tasks, by its canonical key.
   */
  project?: string;
  /**
   * Only tasks in this state, as `search_tasks` takes it. Without it, every task that is not done.
   */
  status?: "open" | "claimed" | "handed_off" | "done";
  /**
   * The most tasks to return.
   */
  limit: number;
}
/**
 * `GET /api/activity` query.
 */
export interface ActivityParams {
  /**
   * How far back to count, in days.
   */
  days: number;
}
/**
 * `GET /api/export` query. The answer is one Markdown document, sent as a download.
 */
export interface ExportParams {
  /**
   * Only this project; every project when left out.
   */
  project?: string;
}
/**
 * `GET /api/host-proof` query.
 */
export interface HostProofParams {
  /**
   * Random bytes the asker made up for this one question, in hex.
   */
  challenge: string;
}
/**
 * `POST /api/projects`: a named project of the person's own, `me/<slug>`.
 */
export interface NewProjectRequest {
  /**
   * Lower-case letters, digits and hyphens, starting with a letter or a digit. It never changes.
   */
  slug: string;
  /**
   * The display name.
   */
  name?: string;
}
/**
 * `POST /api/hooks/claude-code`: what Claude Code hands one of its hooks, sent on as it came. Only what the server reads is named here: the harness sends more, and adds to it between versions.
 */
export interface ClaudeCodeHook {
  /**
   * The event. The server acts on `SessionStart`, `PreToolUse`, `Stop` and `SessionEnd`, and answers any other with nothing.
   */
  hook_event_name: string;
  /**
   * Claude Code's own id of the conversation.
   */
  session_id: string;
  /**
   * `PreToolUse`: the id of the tool call about to be made, which the call itself then carries.
   */
  tool_use_id?: string;
  /**
   * `Stop`: the agent's last message. It is scanned like any write, kept private to the person, and its beginning is what is kept.
   */
  last_assistant_message?: string;
}
/**
 * `POST /api/projects/choice`: the person's choice for one project. Only a signed-in browser makes it.
 */
export interface ProjectChoiceRequest {
  /**
   * The project, as a tool call names it.
   */
  project: string;
  /**
   * `shared` shows what the person publishes there that others can check, and their tasks, to everyone on the server; `private` keeps all of it theirs and takes back what they shared.
   */
  treatment: "private" | "shared";
}
/**
 * `POST /sign-in`: signs a browser in to the dashboard with the person's own key. A harness's token is refused here.
 */
export interface SignInRequest {
  key: string;
}
/**
 * `POST /api/people`: adds a person with a token for their harness and a key for themselves, or, with `another`, issues one more credential to a person who is there.
 */
export interface InviteRequest {
  /**
   * The person's name, as others see it beside what they share.
   */
  name: string;
  /**
   * For a person who is already there: the one credential to issue, a harness token or a dashboard key. Without it a name that is taken is refused.
   */
  another?: "agent" | "person";
  /**
   * What the credential is for, for example the machine it goes on.
   */
  label?: string;
  /**
   * The name of whoever runs the server, as others will see it: needed once, before the first person is added.
   */
  operator_name?: string;
}
/**
 * `GET /api/session`: who is signed in. A 401 means nobody: the person runs `ukt ui` again.
 */
export interface DashboardSession {
  /**
   * The person's display name.
   */
  person: string;
  /**
   * The value to send in the CSRF header.
   */
  csrf: string;
  /**
   * When the cookie stops working. ISO 8601, UTC.
   */
  expires_at: string;
}
/**
 * `GET /api/host-proof`: proof that the server holds the secret of the host it runs on, without showing it.
 */
export interface HostProof {
  /**
   * HMAC-SHA-256 of the challenge under the host's secret, in hex.
   */
  proof: string;
}
/**
 * `POST /api/sign-in-codes`: a code that signs a browser in once, within a few minutes.
 */
export interface SignInCode {
  code: string;
  /**
   * The link to open: the server's own URL, the sign-in path and the code.
   */
  url: string;
  /**
   * ISO 8601, UTC.
   */
  expires_at: string;
}
/**
 * `GET /api/capabilities`: what this server is and what it can do.
 */
export interface CapabilityDescriptor {
  /**
   * `community` for the open server; an overlay names its own.
   */
  edition: string;
  contract_version: string;
  /**
   * The MCP protocol revisions `/mcp` answers, oldest first.
   */
  mcp_revisions: string[];
  features: {
    /**
     * Whether an embedding model is installed, so search has its vector pass.
     */
    vector: boolean;
    /**
     * Whether tasks are served.
     */
    tasks: boolean;
    /**
     * Whether the first result of a session carries a brief.
     */
    brief: boolean;
    /**
     * Whether a harness's hook can leave a session's note (`POST /api/hooks/claude-code`).
     */
    closing_note: boolean;
    /**
     * The follow-up jobs this server runs.
     */
    jobs: string[];
  };
  /**
   * Who may run a job's model step; empty means rules only.
   */
  model_runners: string[];
  /**
   * The tools `tools/list` returns.
   */
  tools: string[];
  /**
   * The commands `prompts/list` returns.
   */
  prompts: string[];
  /**
   * What is incomplete, for example `no_model`.
   */
  degraded: string[];
}
/**
 * `GET /api/connect`: everything the Connect page shows.
 */
export interface ConnectInfo {
  /**
   * The MCP endpoint, for example `http://127.0.0.1:7410/mcp`.
   */
  mcp_url: string;
  /**
   * The name the server is added under: `uketsugi`.
   */
  server_name: string;
  /**
   * Whether a harness added by someone asking from where this request came must send a token. False for a server that only its own machine reaches and that has one person, asked from that machine; the harness lines are then those without a token.
   */
  needs_token: boolean;
  /**
   * The environment variable that holds the token. The token itself is never returned.
   */
  token_env: string;
  /**
   * The line that puts the token in that variable, typed in a shell on the server's host: `export UKT_TOKEN="$(ukt token)"`.
   */
  token_command: string;
  commands: {
    setup: ConnectCommand;
    activate: ConnectCommand;
  };
  /**
   * The block as it stands in an instruction file, fence lines included: shown for reference.
   */
  block: string;
  harnesses: ConnectHarness[];
}
/**
 * One of the two commands the server offers as MCP prompts.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "connectCommand".
 */
export interface ConnectCommand {
  /**
   * The prompt's name: `setup` or `activate`.
   */
  name: string;
  description: string;
}
/**
 * How one harness is connected, as text the person copies.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "connectHarness".
 */
export interface ConnectHarness {
  /**
   * A stable key, for example `claude-code`.
   */
  id: string;
  /**
   * The harness's name as the page shows it.
   */
  name: string;
  /**
   * The harness's plugin, where it has one and the person asking can install it from here. With it nobody runs set-up or places the block.
   */
  plugin?: {
    /**
     * The shell lines that install it, the token read from the variable `token_env` names where `needs_token` says one is sent.
     */
    install: string;
    /**
     * The shell command that takes it out again.
     */
    remove: string;
    /**
     * Whether the plugin also adds the server to the harness: `add` is then for someone who goes without the plugin.
     */
    adds_server: boolean;
  };
  /**
   * What adds the server to the harness: a shell command, or the URL itself. It carries the token where `needs_token` is true.
   */
  add: string;
  /**
   * What kind of text `add` is.
   */
  add_kind: "command" | "url";
  /**
   * For `command`: what takes the server out of the harness again. A harness keeps the token it was added with, so this comes before adding it with another.
   */
  remove?: string;
  /**
   * What the person types to run set-up, as the harness names a server's prompts when the server is added by its address alone; absent where the harness offers no server commands.
   */
  setup?: string;
  /**
   * What the person types to use memory in one session without set-up, as `setup` is typed; absent where the harness offers no server commands.
   */
  activate?: string;
  /**
   * The user-level instruction file set-up writes the block to, as the place it usually is; absent where the server cannot know it.
   */
  instruction_file?: string;
  /**
   * A shell command that prints that file's path on the person's machine, for a harness whose file is not always in the usual place. The set-up command has the agent run it.
   */
  instruction_file_command?: string;
  /**
   * One line on anything this harness does differently.
   */
  note?: string;
  /**
   * How this row is known: run on a named version of the harness, a dated documentation page, or not established.
   */
  known: string;
}
/**
 * `GET /api/facts`.
 */
export interface FactPage {
  facts: ApiFact[];
  /**
   * The cursor of the next page; null on the last one. A search has one page.
   */
  next: string | null;
  /**
   * For a search: how many facts matched.
   */
  matched?: number;
}
/**
 * A fact as the dashboard shows it. A redacted fact is a stub: its text is null.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "apiFact".
 */
export interface ApiFact {
  id: string;
  project: string;
  audience: Audience;
  claim: string | null;
  detail: string | null;
  question: string | null;
  citations: Citation[];
  status: Status;
  flags: FlagKind[];
  trust: Trust;
  /**
   * Who wrote it: `you` for the reader's own, otherwise the person's name.
   */
  author: string;
  /**
   * Whether the reader wrote it: only its author can redact a fact.
   */
  own: boolean;
  redacted: boolean;
  /**
   * ISO 8601, UTC.
   */
  created_at: string;
  /**
   * ISO 8601, UTC.
   */
  updated_at: string;
  /**
   * The newest confirmation, if any.
   */
  confirmed_at: string | null;
  /**
   * The live fact at the head of the chain, when this one is superseded.
   */
  superseded_by: string | null;
}
/**
 * `GET /api/facts/:id`.
 */
export interface FactDetail {
  fact: ApiFact;
  confirmations: ApiConfirmation[];
  /**
   * Newest first.
   */
  history: FactHistoryEntry[];
  /**
   * Present for the reader's own fact that only they see, while nothing has replaced it and other people are on the server.
   */
  private_because?: "project" | "no_source" | "cites_private" | "merged_word";
}
/**
 * One person's check of a fact.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "apiConfirmation".
 */
export interface ApiConfirmation {
  person: string;
  /**
   * The check is the fact's author's own: it refreshes the fact and does not confirm it, which takes another person's.
   */
  by_author: boolean;
  /**
   * ISO 8601, UTC.
   */
  at: string;
  checked: string | null;
  source_version: string | null;
}
/**
 * One thing that happened to a fact, from the event log: kinds and ids, never text.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "factHistoryEntry".
 */
export interface FactHistoryEntry {
  /**
   * For example `FactPublished`, `FactRewritten`, `FactConfirmed`, `FlagRaised`.
   */
  kind: string;
  /**
   * Who did it: a person's display name, or a job's name.
   */
  actor: string;
  /**
   * ISO 8601, UTC.
   */
  at: string;
}
/**
 * `POST /api/facts/:id/redact`: the fact is now a stub and agents stop receiving it.
 */
export interface RedactResult {
  id: string;
  redacted: true;
}
/**
 * `GET /api/tasks`: the tasks the person can see, in the order `search_tasks` lists them to an agent.
 */
export interface TaskPage {
  tasks: ApiTask[];
  /**
   * How many tasks matched; `tasks` holds the first of them.
   */
  matched: number;
}
/**
 * `GET /api/tasks/:id`: one task with its description, every note and its history.
 */
export interface TaskDetail {
  task: ApiTask;
  /**
   * Oldest first.
   */
  notes: TaskNote[];
  /**
   * Who published, claimed, released and finished it, oldest first, as far as the logs the person may see hold it.
   */
  history: TaskEvent[];
}
/**
 * `GET /api/rulings`: the newest rulings first, at most 50.
 */
export interface RulingList {
  rulings: ApiRuling[];
}
/**
 * One decision a person or a job made about a fact: codes and ids, never text.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "apiRuling".
 */
export interface ApiRuling {
  id: string;
  /**
   * For example `merge_duplicate`, or `revert` for the ruling that undid another.
   */
  decision: string;
  /**
   * The fact the ruling is about.
   */
  fact: string;
  /**
   * Who decided: a person's display name, or a job's name.
   */
  actor: string;
  /**
   * Who ran the job's step, `rules` where no model did; absent for a person.
   */
  runner?: string;
  /**
   * Reason codes.
   */
  reasons: string[];
  /**
   * ISO 8601, UTC.
   */
  at: string;
  /**
   * The ruling that undid this one, if one did.
   */
  reverted_by: string | null;
  /**
   * Whether `POST /api/rulings/:id/revert` would undo it.
   */
  revertible: boolean;
}
/**
 * `POST /api/rulings/:id/revert`. `reverted` is false when the ruling had been reverted already.
 */
export interface RevertResult {
  id: string;
  reverted: boolean;
}
/**
 * `GET /api/activity`.
 */
export interface ActivityReport {
  /**
   * The start of the counted period. ISO 8601, UTC.
   */
  since: string;
  clients: ActivityClient[];
  /**
   * The person's own sessions, newest first, at most 20.
   */
  recent: ActivitySession[];
}
/**
 * What the sessions of one client name and version did.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "activityClient".
 */
export interface ActivityClient {
  client: string;
  version: string | null;
  sessions: number;
  /**
   * Sessions that searched at least once.
   */
  searched: number;
  /**
   * Sessions that published at least once.
   */
  published: number;
  /**
   * Sessions that had a call refused for a missing or malformed project.
   */
  refused: number;
}
/**
 * One inferred session of the person, for "recent sessions".
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "activitySession".
 */
export interface ActivitySession {
  /**
   * The display id results show, for example `s-7f2c`.
   */
  session: string;
  client: string;
  version: string | null;
  /**
   * Null for a session of calls refused for a missing project.
   */
  project: string | null;
  /**
   * ISO 8601, UTC.
   */
  first_call_at: string;
  /**
   * ISO 8601, UTC.
   */
  last_call_at: string;
  last_search_at: string | null;
  last_publish_at: string | null;
  refused_calls: number;
}
/**
 * `GET /api/projects`.
 */
export interface ProjectList {
  projects: ApiProject[];
  /**
   * Whether this server has other people, so that a project can be shared with them.
   */
  sharing: boolean;
}
/**
 * A project the person works in, as the dashboard lists it.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "apiProject".
 */
export interface ApiProject {
  /**
   * `host/owner/name` for a repository; `<owner>/<slug>` for a named project.
   */
  key: string;
  kind: "repository" | "named";
  /**
   * A named project's display name.
   */
  name: string | null;
  /**
   * How many live facts it holds that the person can see.
   */
  facts: number;
  /**
   * How the person treats it: `shared` shows what they publish there that others can check to everyone on the server.
   */
  treatment: "private" | "shared";
  /**
   * False while the person has made no choice: the project is private until they do.
   */
  chosen: boolean;
}
/**
 * `POST /api/hooks/claude-code`: the hook's output, as Claude Code reads it. Empty for every event but `SessionStart`.
 */
export interface ClaudeCodeHookOutput {
  hookSpecificOutput?: {
    hookEventName: "SessionStart";
    /**
     * What the session starts from: the block, then the session's brief where the hook named the project.
     */
    additionalContext: string;
  };
}
/**
 * `POST /api/projects/choice`: the choice as it now stands, and what it moved.
 */
export interface ProjectChoice {
  project: string;
  treatment: "private" | "shared";
  /**
   * How many of the person's facts and tasks changed hands: to everyone when shared, back to the person when private.
   */
  moved: {
    facts: number;
    tasks: number;
  };
}
/**
 * `GET /api/people`: everyone on the server, each with their credentials.
 */
export interface PeopleList {
  people: ApiPerson[];
}
/**
 * A person of the server with their credentials.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "apiPerson".
 */
export interface ApiPerson {
  id: string;
  /**
   * The name others see beside what the person shares.
   */
  name: string;
  tokens: ApiToken[];
}
/**
 * A person's credential as whoever runs the server lists it. The secret itself is never returned.
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "apiToken".
 */
export interface ApiToken {
  /**
   * What `ukt revoke` takes.
   */
  id: string;
  /**
   * `agent`: a token a harness sends, for the tools and for reading. `person`: a key the person keeps to themselves, which signs them in to the dashboard and does nothing else.
   */
  kind: "agent" | "person";
  label: string;
  /**
   * ISO 8601, UTC.
   */
  created_at: string;
  /**
   * When a request last signed in with it, to the minute; null until one has.
   */
  last_used_at: string | null;
  /**
   * When it stopped working, if it has.
   */
  revoked_at: string | null;
}
/**
 * `POST /api/people`: what to hand to the person. Each secret is shown once.
 */
export interface Invitation {
  /**
   * The person's name.
   */
  person: string;
  /**
   * False when the person was there already.
   */
  added: boolean;
  /**
   * The credentials made by this call.
   */
  issued: {
    kind: "agent" | "person";
    /**
     * What `ukt revoke` takes.
     */
    id: string;
    label: string;
    /**
     * The token or the key itself.
     */
    secret: string;
  }[];
}
/**
 * `POST /api/tokens/:id/revoke`.
 */
export interface TokenRevoked {
  id: string;
  /**
   * False when it was revoked already.
   */
  revoked: boolean;
}

export const TOOL_NAMES = ["search_facts","publish_fact","update_fact","search_tasks","publish_task","claim_task","update_task"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
/** Each tool's arguments, once validated. */
export interface ToolInputs {
  search_facts: SearchFactsInput;
  publish_fact: PublishFactInput;
  update_fact: UpdateFactInput;
  search_tasks: SearchTasksInput;
  publish_task: PublishTaskInput;
  claim_task: ClaimTaskInput;
  update_task: UpdateTaskInput;
}
/** Each tool's result. */
export interface ToolResults {
  search_facts: SearchFactsResult;
  publish_fact: PublishFactResult;
  update_fact: UpdateFactResult;
  search_tasks: SearchTasksResult;
  publish_task: PublishTaskResult;
  claim_task: ClaimTaskResult;
  update_task: UpdateTaskResult;
}
/** Each `/api` request's query or body, once validated. */
export interface ApiRequests {
  FactListParams: FactListParams;
  TaskListParams: TaskListParams;
  ActivityParams: ActivityParams;
  ExportParams: ExportParams;
  HostProofParams: HostProofParams;
  NewProjectRequest: NewProjectRequest;
  ClaudeCodeHook: ClaudeCodeHook;
  ProjectChoiceRequest: ProjectChoiceRequest;
  SignInRequest: SignInRequest;
  InviteRequest: InviteRequest;
}
