/**
 * What crosses into core is checked here, against the contract's own schemas: a tool's arguments
 * and an `/api` request's query or body. One language states every shape, bound and default; a
 * validated value has its defaults filled in.
 */
import {
  API_REQUEST_SCHEMAS,
  LIMITS,
  TOOLS,
  type ApiRequests,
  type ToolInputs,
  type ToolName,
} from "@uketsugi/contracts";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { invalidInput, overLong, type ToolFailure } from "./failure.ts";

type Checks<Shapes> = { [N in keyof Shapes]: ValidateFunction<Shapes[N]> };

function compileAll<Shapes>(
  ajv: Ajv,
  schemas: Iterable<readonly [string, object]>,
): Checks<Shapes> {
  const compiled = Array.from(schemas, ([name, schema]) => [name, ajv.compile(schema)]);
  return Object.fromEntries(compiled) as Checks<Shapes>;
}

const SETTINGS = { allErrors: true, strict: true, useDefaults: true } as const;
const requests = Object.entries(API_REQUEST_SCHEMAS);

const tools = compileAll<ToolInputs>(
  new Ajv(SETTINGS),
  TOOLS.map((tool) => [tool.name, tool.inputSchema]),
);
const bodies = compileAll<ApiRequests>(new Ajv(SETTINGS), requests);
/** A query string holds text only, so a number arrives as its digits. */
const queries = compileAll<ApiRequests>(new Ajv({ ...SETTINGS, coerceTypes: true }), requests);

/** Whether a value that arrived as JSON is an object with keys: not null, and not a list. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What agents send in place of the declared shape often enough to accept: one citation, a bare confirmation. */
function lenient(args: Record<string, unknown>): Record<string, unknown> {
  const { citations, confirm } = args;
  return {
    ...args,
    ...(typeof citations === "string" || isRecord(citations) ? { citations: [citations] } : {}),
    ...(typeof confirm === "string" ? { confirm: { checked: confirm } } : {}),
  };
}

/** A fault's place as a caller would write it: `confirm.checked`. A field the schema does not hold is named itself. */
function pathOf(error: ErrorObject): string {
  const extra =
    error.keyword === "additionalProperties" ? [String(error.params.additionalProperty)] : [];
  return [...error.instancePath.split("/").slice(1), ...extra].join(".");
}

/** The length of the text a fault is about. */
function lengthAt(value: unknown, error: ErrorObject): number {
  const found = error.instancePath
    .split("/")
    .slice(1)
    .reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), value);
  return typeof found === "string" ? found.length : 0;
}

/**
 * The failure of a value its schema refused: a text over its limit is refused by name with both
 * lengths; anything else names each fault by its path. A submitted value is never echoed.
 */
function refusal(
  value: unknown,
  errors: readonly ErrorObject[],
  wording: { what: string; next: string },
): ToolFailure {
  const long = errors.find((error) => error.keyword === "maxLength");
  if (long !== undefined) {
    return overLong(pathOf(long), lengthAt(value, long), Number(long.params.limit));
  }
  const issues = errors.map((error) => ({
    path: pathOf(error) || "(arguments)",
    message:
      error.keyword === "additionalProperties"
        ? "is not a field this takes"
        : (error.message ?? "is not valid"),
  }));
  const listed = issues.map((issue) => `${issue.path} ${issue.message}`).join("; ");
  return invalidInput(`${wording.what}: ${listed}.`, wording.next, { issues });
}

/** `citations` is bounded as a whole, as sent: no schema keyword says that of a list of texts and objects. */
function refuseLongCitations(sent: unknown): void {
  const length = sent === undefined ? 0 : JSON.stringify(sent).length;
  if (length > LIMITS.citations_chars) throw overLong("citations", length, LIMITS.citations_chars);
}

function takes(tool: ToolName): string {
  const schema = TOOLS.find((candidate) => candidate.name === tool)?.inputSchema;
  const properties = isRecord(schema?.properties) ? Object.keys(schema.properties) : [];
  return `${tool} takes: ${properties.join(", ")}.`;
}

/**
 * A call's arguments as the tool's input contract accepts them, with its defaults filled in, or an
 * `invalid_input` failure that says what is wrong and what the tool takes.
 */
export function validateInput<N extends ToolName>(tool: N, args: unknown): ToolInputs[N] {
  const validate: ValidateFunction<ToolInputs[N]> = tools[tool];
  const input = lenient(isRecord(args) ? args : {});
  refuseLongCitations(input.citations);
  if (validate(input)) return input;
  const what = `${tool} was called with arguments it does not accept`;
  throw refusal(input, validate.errors ?? [], { what, next: takes(tool) });
}

/** An `/api` request's query or JSON body as its contract accepts it, with its defaults filled in. */
export function validateRequest<N extends keyof ApiRequests>(
  name: N,
  part: "query" | "body",
  sent: unknown,
): ApiRequests[N] {
  const validate: ValidateFunction<ApiRequests[N]> = (part === "query" ? queries : bodies)[name];
  const value = isRecord(sent) ? { ...sent } : {};
  if (validate(value)) return value;
  const what = `The request's ${part} is not what this route takes`;
  throw refusal(value, validate.errors ?? [], {
    what,
    next: "Send the fields the route's contract lists.",
  });
}
