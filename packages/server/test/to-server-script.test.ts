/** What the plugin's script sends a server: the machine and the directory a session started in. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

const SCRIPT = fileURLToPath(new URL("../plugins/claude-code/hooks/to-server.sh", import.meta.url));

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "to-server-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

/** Runs the script for a session started in `directory`; resolves with the headers a server was sent. */
async function headersSentFor(directory: string): Promise<IncomingHttpHeaders> {
  const received = Promise.withResolvers<IncomingHttpHeaders>();
  const listener = createServer((request, response) => {
    received.resolve(request.headers);
    request.resume();
    response.end("{}");
  });
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const child = spawn("sh", [SCRIPT, "Stop"], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      CLAUDE_PLUGIN_OPTION_URL: `http://127.0.0.1:${port}`,
      CLAUDE_PROJECT_DIR: directory,
    },
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.end('{"hook_event_name":"Stop"}');
  try {
    return await received.promise;
  } finally {
    child.kill();
    listener.close();
  }
}

const DIRECTORIES = [
  "work",
  "jé",
  "データ",
  "a b",
  "%41",
  'say "hi" now',
  "back\\slash",
  "two\nlines",
  "tab\there",
];

test.each(DIRECTORIES)(
  "the script sends this machine's name and the directory %j so that the server names the agent's own folder",
  async (name) => {
    const directory = join(root, name);
    await mkdir(directory, { recursive: true });
    const sent = await headersSentFor(directory);
    const machine = hostname();
    const text = (header: string | string[] | undefined) =>
      decodeURIComponent(typeof header === "string" ? header : "");
    expect(text(sent["x-uketsugi-directory"])).toBe(directory);
    expect(text(sent["x-uketsugi-machine"])).toBe(machine);
  },
);
