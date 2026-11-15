import { connectInfo, SERVER_NAME } from "@uketsugi/server";
import { expect, test } from "vitest";
import { connectLines } from "../src/harness-lines.ts";

test("Cursor's lines say which file to edit and what to put in it, not only the address", () => {
  const ORIGIN = "http://127.0.0.1:7410";
  const lines = connectLines(connectInfo(ORIGIN, null, false), "export UKT_TOKEN=x");

  const at = lines.indexOf("Cursor");
  expect(lines.slice(at, at + 3)).toEqual([
    "Cursor",
    '  Cursor has no command that adds a server. In ~/.cursor/mcp.json, under "mcpServers", add:',
    `  "${SERVER_NAME}": {"url": "${ORIGIN}/mcp"}`,
  ]);
});
