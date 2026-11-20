/**
 * One Claude Code process in the sandbox: `claude -p` with stream-json output, tailed as it is written
 * so that quick mode can end it at its first source write, then read into a `Transcript`. The model
 * API is reached through the case's forwarder, which counts the tokens even of a session ended early.
 * The sign-in goes into the one `claude` process's environment: never a file or a command line.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MODEL_PORT, type Environment } from "./environment.ts";
import { start, stop } from "./process.ts";
import { parseTranscript, writesSource, type Init, type Transcript } from "./transcript.ts";

const BASE_TOOLS = "Bash,Read,Edit,Write,Glob,Grep,Agent";
const POLL_MS = 300;

export interface SessionOptions {
  readonly home: string;
  readonly tree: string;
  readonly prompt: string;
  /** A model alias (haiku, sonnet, opus) or a full id, as `claude --model` takes it. */
  readonly model: string;
  /** Tools beyond the base set that the session may use without asking (the memory product's). */
  readonly allowedTools: string;
  /** A transcript is written to `<transcript>` and its stderr to `<transcript>.err`. */
  readonly transcript: string;
  readonly resume?: string | null;
  readonly permissionMode?: "acceptEdits" | "bypassPermissions";
  /** Quick mode: end the session at its first source write. */
  readonly stopAtSourceWrite?: boolean;
  readonly env?: Readonly<Record<string, string>>;
}

export interface InstructionFile {
  readonly where: "home" | "tree";
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** What the session was actually given, as the harness reported it, for the result. */
export interface SetupRecord extends Partial<Init> {
  readonly modelRequested: string;
  readonly firstMessage: string;
  readonly instructionFiles: readonly InstructionFile[];
}

export interface SessionResult {
  readonly sessionId: string | null;
  readonly killed: boolean;
  readonly code: number | null;
  readonly transcript: Transcript;
  readonly setup: SetupRecord;
}

/** The sign-in token: CLAUDE_CODE_OAUTH_TOKEN, else the access token of the credentials file CLAUDE_SIGN_IN names. */
export async function signInToken(): Promise<string> {
  const direct = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  if (direct !== undefined && direct !== "") return direct;
  const file = process.env["CLAUDE_SIGN_IN"];
  if (file === undefined) {
    throw new Error(
      "no sign-in: set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or CLAUDE_SIGN_IN to the credentials file",
    );
  }
  const parsed = JSON.parse(await readFile(file, "utf8")) as {
    claudeAiOauth: { accessToken: string };
  };
  return parsed.claudeAiOauth.accessToken;
}

const INSTRUCTIONS = {
  home: [".claude/CLAUDE.md", ".claude/rules"],
  tree: ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md", ".claude/rules"],
};

/** The files a harness reads as instructions, in the home and the tree, before its first message. */
export async function instructionFiles(home: string, tree: string): Promise<InstructionFile[]> {
  const found: InstructionFile[] = [];
  for (const [where, base] of [
    ["home", home],
    ["tree", tree],
  ] as const) {
    for (const entry of INSTRUCTIONS[where]) {
      const names = entry.endsWith("rules")
        ? (await readdir(join(base, entry)).catch(() => [])).map((n) => join(entry, n))
        : [entry];
      for (const path of names) {
        const data = await readFile(join(base, path)).catch(() => undefined);
        if (data === undefined) continue;
        found.push({
          where,
          path,
          bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        });
      }
    }
  }
  return found;
}

export function argvOf(options: SessionOptions): string[] {
  return [
    "claude",
    "-p",
    options.prompt,
    "--model",
    options.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-hook-events",
    "--permission-mode",
    options.permissionMode ?? "acceptEdits",
    "--allowedTools",
    [BASE_TOOLS, options.allowedTools].filter((t) => t !== "").join(","),
    "--disallowedTools",
    "WebFetch,WebSearch",
    ...(options.resume === undefined || options.resume === null
      ? []
      : ["--resume", options.resume]),
  ];
}

/** Reads what a file has gained since `offset`. */
function readFrom(path: string, offset: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(1 << 20);
    const n = readSync(fd, chunk, 0, chunk.length, offset);
    return chunk.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export async function runSession(
  environment: Environment,
  options: SessionOptions,
): Promise<SessionResult> {
  const files = await instructionFiles(options.home, options.tree);
  const sandbox = await environment.command({
    home: options.home,
    tree: options.tree,
    cmd: argvOf(options),
    claude: true,
    env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      GIT_ALLOW_PROTOCOL: "file",
      CLAUDE_CODE_OAUTH_TOKEN: await signInToken(),
      ...options.env,
    },
  });
  await writeFile(options.transcript, "");
  const out = openSync(options.transcript, "a");
  const err = openSync(`${options.transcript}.err`, "w");
  const child = start(sandbox.command, sandbox.args, {
    env: sandbox.env,
    stdio: ["ignore", out, err],
  });
  closeSync(out);
  closeSync(err);
  const closed = new Promise<number | null>((resolve) =>
    child.once("close", (code) => resolve(code)),
  );
  let killed = false;
  let offset = 0;
  let pending = "";
  let done = false;
  void closed.then(() => (done = true));
  while (!done) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const chunk = readFrom(options.transcript, offset);
    offset += chunk.length;
    const lines = (pending + chunk.toString()).split("\n");
    pending = lines.pop() ?? "";
    if (!killed && options.stopAtSourceWrite === true && lines.some(writesSource)) {
      killed = true;
      await stop(child, "SIGKILL");
    }
  }
  const code = await closed;
  const transcript = parseTranscript(await readFile(options.transcript, "utf8"));
  const result: SessionResult = {
    sessionId: sessionIdOf(await readFile(options.transcript, "utf8")),
    killed,
    code,
    transcript,
    setup: {
      ...transcript.init,
      modelRequested: options.model,
      firstMessage: options.prompt,
      instructionFiles: files,
    },
  };
  const reported = transcript.init?.model ?? null;
  if (reported !== null && !reported.includes(options.model)) {
    throw new Error(`asked for model ${options.model}, the session ran ${reported}`);
  }
  return result;
}

function sessionIdOf(text: string): string | null {
  for (const line of text.split("\n")) {
    const match = /"session_id":"([0-9a-f-]+)"/.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/** Refuses to go on when any kept file under `folder` holds one of the secrets. */
export async function assertNoSecrets(folder: string, secrets: readonly string[]): Promise<void> {
  const live = secrets.filter((s) => s.length >= 8);
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const text = await readFile(path, "utf8").catch(() => "");
    if (live.some((secret) => text.includes(secret))) {
      throw new Error(`a secret is in a file the run kept: ${path}`);
    }
  }
}
