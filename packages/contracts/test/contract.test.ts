import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { generatedFile } from "../scripts/generate-types.ts";
import {
  API_REQUEST_SCHEMAS,
  BLOCK_TEXT,
  CONTRACT_DOCUMENT,
  FENCED_BLOCK,
  PROJECT_REFUSAL,
  SERVER_INSTRUCTIONS,
  pathPrintedBy,
  setupPromptText,
  TOOL_NAMES,
  TOOLS,
} from "../src/index.ts";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("the contract", () => {
  test("the generated types are what the schema generates now (run `pnpm generate` if not)", async () => {
    const { path, text } = await generatedFile();
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  test("publish_fact's citations say how to send what a person told the agent", () => {
    const publish = TOOLS.find((tool) => tool.name === "publish_fact");
    const citations = (publish?.inputSchema.properties as Record<string, { description: string }>)
      .citations;
    expect(citations?.description).toContain(
      'What a person told you is `{"kind":"person","who":"...","quote":"..."}`, the quote being all they said about it, with any limit or condition they put on it.',
    );
  });

  test("every tool requires a project and its input schema is valid JSON Schema", () => {
    const ajv = new Ajv({ strict: true });
    expect(TOOLS.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    for (const tool of TOOLS) {
      expect(tool.inputSchema.required, tool.name).toContain("project");
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
    }
  });

  test("every shape compiles against the shared definitions: results, the error, and what /api takes and gives", () => {
    const ajv = new Ajv2020({ strict: false });
    ajv.addSchema(CONTRACT_DOCUMENT);
    const id = String(CONTRACT_DOCUMENT.$id);
    const api = CONTRACT_DOCUMENT.api as Record<"requests" | "responses", object>;
    const paths = [
      "error",
      ...TOOL_NAMES.map((name) => `results/${name}`),
      ...Object.keys(api.requests).map((name) => `api/requests/${name}`),
      ...Object.keys(api.responses).map((name) => `api/responses/${name}`),
    ];
    for (const path of paths) expect(ajv.getSchema(`${id}#/${path}`), path).toBeTypeOf("function");
    expect(Object.keys(API_REQUEST_SCHEMAS)).toEqual(Object.keys(api.requests));
  });

  test("the measured texts are the ones the recording runs used, and the instructions stay short", () => {
    expect(sha256(BLOCK_TEXT)).toBe(
      "9954e16ca3cdcbf90f9b97db8ae92c4bdb4abb8cfe87a6a91bcbe5629d207800",
    );
    expect(PROJECT_REFUSAL).toBe(
      "project is required. Pass this repository's origin remote as host/owner/name (run: git remote get-url origin). If this directory is not a repository, pass the project named in your instructions.",
    );
    expect(setupPromptText("~/.claude/CLAUDE.md")).toBe(
      `Add the block below at the very top of my user-level instruction file (~/.claude/CLAUDE.md), creating the file if it does not exist. Keep everything already in the file, unchanged, below it. Do not change the block's text.\n\n${FENCED_BLOCK}`,
    );
    // A file that is not in one place on every machine is named by the command that prints its
    // path, which the agent runs: only the words in the brackets differ from the measured text.
    expect(setupPromptText(pathPrintedBy('echo "$HOME/x.md"'))).toBe(
      `Add the block below at the very top of my user-level instruction file (run this command and use the path it prints: echo "$HOME/x.md"), creating the file if it does not exist. Keep everything already in the file, unchanged, below it. Do not change the block's text.\n\n${FENCED_BLOCK}`,
    );
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(500);
  });
});
