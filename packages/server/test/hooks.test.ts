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

/** The script's encoding of a value for a header: every byte as `%xx`, so any text travels as ASCII. */
const asSent = (value: string) =>
  [...Buffer.from(value, "utf8")].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");

/** A server with one person, and a way to send it a conversation's hooks as the script sends them. */
async function folderServer() {
  const local = await openLocalPorts({});
  await acceptToken(local.ports, local.owner, TOKEN, "test");
  const server = composeServer({ ports: local.ports });
  const send = async (event: object, headers: Record<string, string>) => {
    const response = await server.fetch(
      new Request("http://127.0.0.1/api/hooks/claude-code", {
        method: "POST",
        headers: {
          host: "127.0.0.1",
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify({ session_id: "c-1", ...event }),
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as ClaudeCodeHookOutput;
  };
  const sessionIn = (key: string) =>
    local.ports.store.sessions.latest(local.owner.orgId, local.owner.principalId, key);
  const close = async () => {
    await server.close();
    await local.close();
  };
  return { send, sessionIn, close };
}

const FOLDERS = [
  "/home/ann/work",
  "/home/jé/proj",
  "/srv/データ",
  "/tmp/a b",
  "/tmp/%41",
  '/tmp/say "hi" now',
  "/tmp/back\\slash",
  "/tmp/two\nlines",
];

test.each(FOLDERS)(
  "a session in %j with no origin begins in the folder's project, and its note lands there",
  async (directory) => {
    const { send, sessionIn, close } = await folderServer();
    try {
      const folder = {
        "x-uketsugi-machine": asSent("Box"),
        "x-uketsugi-directory": asSent(directory),
      };
      const started = await send({ hook_event_name: "SessionStart" }, folder);
      const context = started.hookSpecificOutput?.additionalContext ?? "";
      expect(context.startsWith(BLOCK_TEXT)).toBe(true);
      expect(context.length).toBeGreaterThan(BLOCK_TEXT.length);
      // The agent's own text for the folder names the same project.
      const key = `file://box${directory}`;
      expect(await sessionIn(key)).not.toBeNull();
      await send({ hook_event_name: "Stop", last_assistant_message: "Did the thing." }, folder);
      expect((await sessionIn(key))?.note?.text).toBe("Did the thing.");
    } finally {
      await close();
    }
  },
);

test("an origin that names a project wins over the folder; one that does not leaves the folder", async () => {
  const { send, sessionIn, close } = await folderServer();
  try {
    const folder = {
      "x-uketsugi-machine": asSent("box"),
      "x-uketsugi-directory": asSent("/srv/api"),
    };
    await send(
      { hook_event_name: "SessionStart" },
      { ...folder, "x-uketsugi-origin": "https://github.com/acme/api.git" },
    );
    expect(await sessionIn("github.com/acme/api")).not.toBeNull();
    expect(await sessionIn("file://box/srv/api")).toBeNull();
    await send(
      { hook_event_name: "SessionStart", session_id: "c-2" },
      { ...folder, "x-uketsugi-origin": "/srv/git/api.git" },
    );
    expect(await sessionIn("file://box/srv/api")).not.toBeNull();
  } finally {
    await close();
  }
});

test("with no machine, no folder's project is made and the session starts with the block alone", async () => {
  const { send, close } = await folderServer();
  try {
    const started = await send(
      { hook_event_name: "SessionStart" },
      { "x-uketsugi-directory": asSent("/srv/api") },
    );
    expect(started.hookSpecificOutput?.additionalContext).toBe(BLOCK_TEXT);
  } finally {
    await close();
  }
});
