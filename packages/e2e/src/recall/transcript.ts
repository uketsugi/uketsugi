/**
 * Reads a Claude Code session's stream-json transcript (the harness's `--output-format stream-json
 * --verbose --include-hook-events`) into what a measure needs and nothing else:
 * - `init`: what the harness reports it started with (model, version, MCP servers, plugins);
 * - `deliveries`: the decoded text of every hook output and every tool result, with the turn that
 *   produced it. A turn is one assistant message; a hook that ran before the first has turn 0, and a
 *   tool result has the turn of the call it answers, so a delivery of turn t can inform turns after t;
 * - `calls`: every tool call with its turn and event index;
 * - `firstSourceWrite`: the first call that writes a file of the project (see `isSourceWrite`).
 */
export interface Init {
  readonly model: string | null;
  readonly version: string | null;
  readonly mcpServers: readonly { name: string; status: string }[];
  readonly plugins: readonly { name: string; source: string | null }[];
}

export interface Delivery {
  /** Index of the transcript line that carried it. */
  readonly index: number;
  readonly turn: number;
  readonly via: "hook" | "tool";
  /** The hook's name, or the tool's. */
  readonly name: string;
  readonly text: string;
}

export interface ToolCall {
  readonly index: number;
  readonly turn: number;
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface Transcript {
  readonly init: Init | undefined;
  readonly deliveries: readonly Delivery[];
  readonly calls: readonly ToolCall[];
  readonly firstSourceWrite: ToolCall | undefined;
}

const FILE_WRITES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Shell commands that edit a file in place: sed -i, patch, git apply, tee, a redirect to a path that is not scratch, and Python's file writes (the model edits through
 * the shell as often as through the editing tools). */
const SHELL_WRITE =
  /\bsed\b[^|;&\n]*\s-[A-Za-z]*i|\bpatch\b|\bgit\s+apply\b|\btee\s+(?!\/(?:tmp|dev)\b)|(?<![0-9&>])>{1,2}\s*(?!&|\/(?:tmp|dev)\b)[^\s&|]|\bopen\([^)]*['"][wa]b?['"]|\.write(?:_text|_bytes)?\(/;

/** A write to the project: a file tool aimed away from scratch space, or a shell command that edits in place. */
export function isSourceWrite(name: string, input: Record<string, unknown>): boolean {
  if (FILE_WRITES.has(name)) {
    const path = input["file_path"] ?? input["notebook_path"];
    return typeof path !== "string" || !path.startsWith("/tmp/");
  }
  return name === "Bash" && SHELL_WRITE.test(str(input["command"]));
}

type Json = Record<string, unknown>;

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const blocksOf = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);

/** A tool result's text, whether the harness gave a string or a list of blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return blocksOf(content)
    .map((block) => (typeof block === "string" ? block : str(block["text"])))
    .join("\n");
}

/** A hook's output as the agent sees it: the `additionalContext` of its JSON output, else its text. */
function hookText(output: string): string {
  try {
    const parsed = JSON.parse(output) as { hookSpecificOutput?: { additionalContext?: unknown } };
    const context = parsed.hookSpecificOutput?.additionalContext;
    if (typeof context === "string") return context;
  } catch {
    // plain text
  }
  return output;
}

function initOf(event: Json): Init {
  return {
    model: str(event["model"]) || null,
    version: str(event["claude_code_version"]) || null,
    mcpServers: blocksOf(event["mcp_servers"]).map((s) => ({
      name: str(s["name"]),
      status: str(s["status"]),
    })),
    plugins: blocksOf(event["plugins"]).map((p) => ({
      name: str(p["name"]),
      source: str(p["source"]) || null,
    })),
  };
}

/** Collects a transcript's events one by one, keeping the turn count. */
class Reader {
  init: Init | undefined;
  readonly deliveries: Delivery[] = [];
  readonly calls: ToolCall[] = [];
  private turn = 0;
  private lastMessage = "";
  private readonly callOf = new Map<string, ToolCall>();

  event(index: number, event: Json): void {
    const message = (event["message"] ?? {}) as Json;
    const content = blocksOf(message["content"]);
    if (event["type"] === "assistant")
      this.assistant(index, str(message["id"], String(index)), content);
    else if (event["type"] === "user") this.results(index, content);
    else if (event["type"] === "system") this.system(index, event);
  }

  private system(index: number, event: Json): void {
    if (event["subtype"] === "init") this.init = initOf(event);
    if (event["subtype"] !== "hook_response") return;
    const output = str(event["output"]) || str(event["stdout"]);
    if (output.trim() === "") return;
    const name = str(event["hook_name"]) || str(event["hook_event"], "hook");
    this.deliveries.push({ index, turn: this.turn, via: "hook", name, text: hookText(output) });
  }

  private assistant(index: number, id: string, content: Json[]): void {
    if (id !== this.lastMessage) this.turn += 1;
    this.lastMessage = id;
    for (const block of content.filter((b) => b["type"] === "tool_use")) {
      const call: ToolCall = {
        index,
        turn: this.turn,
        id: str(block["id"]),
        name: str(block["name"]),
        input: (block["input"] ?? {}) as Record<string, unknown>,
      };
      this.calls.push(call);
      this.callOf.set(call.id, call);
    }
  }

  private results(index: number, content: Json[]): void {
    for (const block of content.filter((b) => b["type"] === "tool_result")) {
      const call = this.callOf.get(str(block["tool_use_id"]));
      this.deliveries.push({
        index,
        turn: call?.turn ?? this.turn,
        via: "tool",
        name: call?.name ?? "",
        text: resultText(block["content"]),
      });
    }
  }
}

export function parseTranscript(text: string): Transcript {
  const reader = new Reader();
  for (const [index, line] of text.split("\n").entries()) {
    try {
      reader.event(index, JSON.parse(line) as Json);
    } catch {
      // a line that is not an event (the last, cut short)
    }
  }
  const firstSourceWrite = reader.calls.find((c) => isSourceWrite(c.name, c.input));
  return {
    init: reader.init,
    deliveries: reader.deliveries,
    calls: reader.calls,
    firstSourceWrite,
  };
}

/** True when one transcript line is an assistant message that calls a source write: what quick mode stops a session on. */
export function writesSource(line: string): boolean {
  try {
    const event = JSON.parse(line) as { type?: string; message?: { content?: Json[] } };
    const blocks = event.type === "assistant" ? (event.message?.content ?? []) : [];
    return blocks.some(
      (b) => b["type"] === "tool_use" && isSourceWrite(str(b["name"]), (b["input"] ?? {}) as Json),
    );
  } catch {
    return false;
  }
}
