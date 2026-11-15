import { BLOCK_TEXT, type ClaudeCodeHookOutput } from "@uketsugi/contracts";
import { acceptToken } from "@uketsugi/core";
import { expect, test } from "vitest";
import { composeServer, openLocalPorts } from "../src/index.ts";

const TOKEN = "ukt_test_token_for_the_hooks";

test("a session whose brief cannot be made starts with the block alone, and the fault is reported", async () => {
  const local = await openLocalPorts({});
  await acceptToken(local.ports, local.owner, TOKEN, "test");
  // A store that cannot say how the project's last session ended stands in for any fault in a brief.
  const sessions = Object.create(local.ports.store.sessions) as typeof local.ports.store.sessions;
  sessions.previous = () => Promise.reject(new Error("no disk"));
  const reported: unknown[] = [];
  const server = composeServer({
    ports: { ...local.ports, store: { ...local.ports.store, sessions } },
    onError: (error) => reported.push(error),
  });
  try {
    const started = await server.fetch(
      new Request("http://127.0.0.1/api/hooks/claude-code", {
        method: "POST",
        headers: {
          host: "127.0.0.1",
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "x-uketsugi-origin": "https://github.com/acme/billing-service.git",
        },
        body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "c-1" }),
      }),
    );
    expect(started.status).toBe(200);
    const output = (await started.json()) as ClaudeCodeHookOutput;
    expect(output.hookSpecificOutput?.additionalContext).toBe(BLOCK_TEXT);
    expect(reported).toEqual([new Error("no disk")]);
  } finally {
    await server.close();
    await local.close();
  }
});
