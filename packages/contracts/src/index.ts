import type { ApiRequests, ErrorCode, ToolError, ToolName } from "./generated.ts";
import document from "./contract.schema.json" with { type: "json" };

export * from "./api.ts";
export * from "./generated.ts";
export * from "./retention.ts";
export * from "./texts.ts";

type Schema = Readonly<Record<string, unknown>>;

/** A tool as `tools/list` returns it. */
export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: Schema;
}

/** The whole contract document: the tools, their results, the `/api` shapes, the error shape and what they share. */
export const CONTRACT_DOCUMENT: Schema = document;

/** The tools a server serves, exactly as `tools/list` must return them. */
export const TOOLS = document.tools as readonly ToolDefinition[];

/** The schema of each `/api` request's query or body, by its name in the contract. */
export const API_REQUEST_SCHEMAS: Readonly<Record<keyof ApiRequests, Schema>> =
  document.api.requests;

/**
 * The limits a schema keyword cannot state. `citations_chars` bounds a call's whole `citations`
 * argument as sent; `closing_note_chars` is how much of a session's note is kept, from its start;
 * `turn_request_chars` and `turn_answer_chars` are how much of each side of a captured turn is.
 */
export const LIMITS: Readonly<typeof document.limits> = document.limits;

/** The parts of one error: what happened, what it means, what to do next, whether a retry can help. */
export type ErrorParts = ToolError["error"];

/** Whether a retry can help, per code. A code's wording is written where the error is raised. */
export const ERROR_RETRY: Readonly<Record<ErrorCode, boolean>> = {
  project_required: false,
  invalid_input: false,
  not_found: false,
  forbidden: false,
  unsupported: false,
  unavailable: true,
  internal: false,
  // A task's lease ends unless its holder renews it: the same call can succeed once it has.
  lease_held: true,
  conflict: false,
  unauthorized: false,
};
