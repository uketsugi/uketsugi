/**
 * Turns `src/contract.schema.json` into the TypeScript in `src/generated.ts` with
 * json-schema-to-typescript. `pnpm generate` writes the file; a test fails when the file and the
 * schema disagree.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile, type JSONSchema } from "json-schema-to-typescript";

type Schema = Record<string, unknown>;
interface Tool {
  name: string;
  inputSchema: Schema;
}
interface Contract {
  tools: Tool[];
  results: Record<string, Schema>;
  api: { requests: Record<string, Schema>; responses: Record<string, Schema> };
  error: Schema;
  $defs: Record<string, Schema>;
}

const SCHEMA_URL = new URL("../src/contract.schema.json", import.meta.url);
const RELEASE_URL = new URL("../../cli/package.json", import.meta.url);
const OUTPUT_URL = new URL("../src/generated.ts", import.meta.url);
const BANNER = "// Generated from contract.schema.json by scripts/generate-types.ts. Do not edit.";

/** The release's version, which the contract carries: its one source is the cli's manifest. */
function releaseVersion(): string {
  return (JSON.parse(readFileSync(RELEASE_URL, "utf8")) as { version: string }).version;
}

function pascal(name: string): string {
  return name.replace(/(^|_)([a-z])/g, (_match, _sep, letter: string) => letter.toUpperCase());
}

/**
 * An input as its type describes it: after validation, which fills in every default. A property
 * with a default is therefore always there.
 */
function validated(schema: Schema): Schema {
  const properties = (schema.properties ?? {}) as Record<string, { default?: unknown }>;
  const required = (schema.required ?? []) as string[];
  const defaulted = Object.keys(properties).filter(
    (name) => properties[name]?.default !== undefined,
  );
  return { ...schema, required: [...new Set([...required, ...defaulted])] };
}

/** One schema whose properties are every type the contract names, so that one compile emits them all. */
function rootSchema(contract: Contract): JSONSchema {
  const named: Record<string, Schema> = { ToolError: contract.error };
  for (const tool of contract.tools) {
    named[`${pascal(tool.name)}Input`] = validated(tool.inputSchema);
  }
  for (const [name, schema] of Object.entries(contract.results)) {
    named[`${pascal(name)}Result`] = schema;
  }
  for (const [name, schema] of Object.entries(contract.api.requests)) {
    named[name] = validated(schema);
  }
  Object.assign(named, contract.api.responses);
  const properties = Object.fromEntries(
    Object.entries(named).map(([title, schema]) => [title, { ...schema, title }]),
  );
  return { title: "ContractTypes", type: "object", properties, $defs: contract.$defs };
}

/** An interface that maps each name to the type generated for it. */
function table(name: string, comment: string, entries: readonly (readonly [string, string])[]) {
  const lines = entries.map(([key, type]) => `  ${key}: ${type};`);
  return [`/** ${comment} */`, `export interface ${name} {`, ...lines, "}"].join("\n");
}

/** The whole generated file for a parsed `contract.schema.json`. */
export async function generateTypes(contract: Contract): Promise<string> {
  const types = await compile(rootSchema(contract), "ContractTypes", {
    bannerComment: BANNER,
    additionalProperties: false,
    ignoreMinAndMaxItems: true,
    unreachableDefinitions: true,
    style: { printWidth: 100 },
  });
  const tools = contract.tools.map((tool) => tool.name);
  const typed = (suffix: string) =>
    tools.map((tool) => [tool, `${pascal(tool)}${suffix}`] as const);
  const requests = Object.keys(contract.api.requests).map((name) => [name, name] as const);
  return [
    types,
    `/** The version of this contract: the release's, from \`packages/cli/package.json\`. */\nexport const CONTRACT_VERSION = ${JSON.stringify(releaseVersion())};`,
    `export const TOOL_NAMES = ${JSON.stringify(tools)} as const;`,
    "export type ToolName = (typeof TOOL_NAMES)[number];",
    table("ToolInputs", "Each tool's arguments, once validated.", typed("Input")),
    table("ToolResults", "Each tool's result.", typed("Result")),
    table("ApiRequests", "Each `/api` request's query or body, once validated.", requests),
    "",
  ].join("\n");
}

/** The file as the current schema generates it, and the path it belongs at. */
export async function generatedFile(): Promise<{ path: string; text: string }> {
  const contract = JSON.parse(readFileSync(SCHEMA_URL, "utf8")) as Contract;
  return { path: fileURLToPath(OUTPUT_URL), text: await generateTypes(contract) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { path, text } = await generatedFile();
  writeFileSync(path, text);
}
