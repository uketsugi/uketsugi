/**
 * The HTTP side of the contract: every route the server answers outside `/mcp`, and the few
 * constants a client of it needs. The shapes themselves are in `contract.schema.json` under `api`
 * and are generated from it like the tools' (`generated.ts`). JSON fields are spelled as the tools
 * spell theirs (`updated_at`), and every time is ISO 8601 in UTC.
 *
 * | Method | Path                      | Signed in by       | Body in                | Body out               |
 * | ------ | ------------------------- | ------------------ | ---------------------- | ---------------------- |
 * | GET    | `/sign-in?code=…`         | the one-time code  | none                   | 303 to `/`, cookie set |
 * | POST   | `/sign-in`                | the person's key   | `SignInRequest`        | 204, cookie set        |
 * | GET    | `/api/capabilities`       | nobody             | none                   | `CapabilityDescriptor` |
 * | GET    | `/api/session`            | cookie             | none                   | `DashboardSession`     |
 * | DELETE | `/api/session`            | cookie             | none                   | 204                    |
 * | GET    | `/api/connect`            | cookie or token    | none                   | `ConnectInfo`          |
 * | GET    | `/api/facts`              | cookie or token    | `FactListParams`       | `FactPage`             |
 * | GET    | `/api/facts/:id`          | cookie or token    | none                   | `FactDetail`           |
 * | POST   | `/api/facts/:id/redact`   | cookie             | none                   | `RedactResult`         |
 * | GET    | `/api/tasks`              | cookie or token    | `TaskListParams`       | `TaskPage`             |
 * | GET    | `/api/tasks/:id`          | cookie or token    | none                   | `TaskDetail`           |
 * | GET    | `/api/rulings`            | cookie or token    | none                   | `RulingList`           |
 * | POST   | `/api/rulings/:id/revert` | cookie             | none                   | `RevertResult`         |
 * | GET    | `/api/activity`           | cookie or token    | `ActivityParams`       | `ActivityReport`       |
 * | GET    | `/api/projects`           | cookie or token    | none                   | `ProjectList`          |
 * | POST   | `/api/projects`           | cookie             | `NewProjectRequest`    | `ApiProject`           |
 * | POST   | `/api/projects/choice`    | cookie             | `ProjectChoiceRequest` | `ProjectChoice`        |
 * | GET    | `/api/export`             | cookie or token    | `ExportParams`         | `text/markdown`        |
 * | POST   | `/api/hooks/claude-code`  | cookie or token    | `ClaudeCodeHook`       | `ClaudeCodeHookOutput` |
 * | GET    | `/api/host-proof`         | nobody, loopback   | `HostProofParams`      | `HostProof`            |
 * | POST   | `/api/sign-in-codes`      | host, loopback     | none                   | `SignInCode`           |
 * | GET    | `/api/backup`             | host, loopback     | none                   | `application/gzip`     |
 * | POST   | `/api/model-check`        | host, loopback     | none                   | `ModelCheck`           |
 * | GET    | `/api/people`             | host, loopback     | none                   | `PeopleList`           |
 * | POST   | `/api/people`             | host, loopback     | `InviteRequest`        | `Invitation`           |
 * | POST   | `/api/tokens/:id/revoke`  | host, loopback     | none                   | `TokenRevoked`         |
 * | POST   | `/api/token/rotate`       | host, loopback     | none                   | `TokenReplaced`        |
 *
 * Three credentials sign a request in, and none does another's work.
 * - **token**: the agent token a harness sends as a bearer. It calls the tools on `/mcp`, reads
 *   through `/api`, and is what the harness's hooks send: a session's start, its note, its end.
 * - **cookie**: a person's dashboard session. It is opened by what no harness holds: the person's
 *   own dashboard key, typed into the sign-in page (`POST /sign-in`), or on the host a one-time
 *   link (`ukt ui`). What only a person may do takes it and never a token: choosing how a project
 *   is treated, redacting a fact, undoing a merge, making a named project.
 * - **host**: the host's own secret, kept in its data directory and printed by no verb, sent as a
 *   bearer by `ukt` from the loopback address. It is whoever runs the server: `ukt ui` gets a
 *   sign-in link with it, `ukt backup` a snapshot of the whole store while a server runs, and
 *   `ukt people`, `ukt invite` and `ukt revoke` list people, add them and end a credential. No
 *   person's token is accepted for these, the operator's own harness token included.
 *   Before `ukt` sends the secret or a token it asks whatever listens there to prove it is this
 *   host's server (`/api/host-proof`): a record left by a server that died names a port anything
 *   may have taken since.
 *
 * `…Params` travel in the query string. A request that changes something and is signed in by
 * cookie (POST, DELETE) must carry the header `API_CSRF_HEADER` with the `csrf` value that
 * `GET /api/session` returned; a token request needs none. A failure is the tools' one error
 * shape (`ApiError`) with the HTTP status its code maps to in `API_ERROR_STATUS`.
 */
import type { CitationClass, ErrorCode, ToolError } from "./generated.ts";

/**
 * A citation's class as a person reads it, on the dashboard and in the export. The contract's word
 * for a reference anyone could open is `checkable`, which reads as "checked", and nothing checks a
 * citation: the server opens no source. So a person is told what the server knows, that the
 * reference names something to look up. A tool result keeps the contract's word.
 */
export const CITATION_WORD: Readonly<Record<CitationClass, string>> = {
  checkable: "can be looked up",
  testimony: "testimony",
};

/** The header a cookie-signed request that changes something must carry. */
export const API_CSRF_HEADER = "x-uketsugi-csrf";

/** The environment variable a harness reads the bearer token from. */
export const TOKEN_ENV = "UKT_TOKEN";

/** Where the link `ukt ui` prints points: `<base>/sign-in?code=<code>`. */
export const SIGN_IN_PATH = "/sign-in";

/** The MCP protocol revisions `/mcp` answers: the one with a handshake, and the one without. */
export const MCP_REVISIONS = ["2025-11-25", "2026-07-28"] as const;
export type McpRevision = (typeof MCP_REVISIONS)[number];

/** The one error shape, under the name the HTTP side knows it by. */
export type ApiError = ToolError;

/** The HTTP status of each error code. */
export const API_ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  lease_held: 409,
  conflict: 409,
  project_required: 422,
  invalid_input: 422,
  unsupported: 422,
  unavailable: 503,
  internal: 500,
};

/** Whether a response body is the one error shape. A proxy's page or an empty answer is not. */
export function isApiError(body: unknown): body is ApiError {
  if (typeof body !== "object" || body === null || !("error" in body)) return false;
  const error = body.error;
  return typeof error === "object" && error !== null && "what" in error && "next" in error;
}
