/**
 * Reads a Claude Code session's stream-json transcript (the harness's `--output-format stream-json
 * --verbose --include-hook-events`) into what a measure needs and nothing else:
 * - `init`: what the harness reports it started with (model, version, MCP servers, plugins);
 * - `deliveries`: every hook output and every tool result, as the text the agent was given (the JSON
 *   envelopes taken off, `decode`), with the line it stands at and the turn that produced it. A line
 *   is counted as the runner counts it: every line that parses, from 1. A turn is one assistant
 *   message; a hook before the first has turn 0, and a tool result has the turn of the call it answers;
 * - `calls`: every tool call with its line and turn.
 * Which of the deliveries a memory product made is the product's to say (its adapter).
 */
export interface Init {
  readonly model: string | null;
  readonly version: string | null;
  readonly mcpServers: readonly { name: string; status: string }[];
  readonly plugins: readonly { name: string; source: string | null }[];
}

export interface Delivery {
  /** The line of the transcript it stands at. */
  readonly line: number;
  readonly turn: number;
  readonly via: "hook" | "tool";
  /** The hook's name, or the tool's. */
  readonly name: string;
  /** The tool call's input, for a tool result. */
  readonly input: Record<string, unknown>;
  /** The decoded records, one a line. */
  readonly text: string;
  /** What the product said was left out of a tool result (`degraded` in a search's answer, such as `no_model`); none for a hook. */
  readonly degraded: readonly string[];
}

export interface ToolCall {
  readonly line: number;
  readonly turn: number;
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface Transcript {
  readonly init: Init | undefined;
  readonly deliveries: readonly Delivery[];
  readonly calls: readonly ToolCall[];
}

type Json = Record<string, unknown>;

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const blocksOf = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The characters Python's `str.splitlines()` ends a line at, so that both sides of the port cut the same records. */
const LINE_ENDS = new Set([0x0a, 0x0d, 0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]);

export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (!LINE_ENDS.has(text.charCodeAt(i))) continue;
    lines.push(text.slice(from, i));
    if (text.charCodeAt(i) === 0x0d && text.charCodeAt(i + 1) === 0x0a) i += 1;
    from = i + 1;
  }
  if (from < text.length) lines.push(text.slice(from));
  return lines;
}

/** The text a decoded JSON value holds: a fact as one line, any other string by its lines; a string that is JSON is opened. */
export function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") {
    let inner: unknown;
    try {
      inner = JSON.parse(value);
    } catch {
      inner = undefined;
    }
    if (isObject(inner) || Array.isArray(inner)) yield* strings(inner);
    else yield* splitLines(value).filter((l) => l.trim() !== "");
  } else if (Array.isArray(value)) {
    for (const v of value) yield* strings(v);
  } else if (isObject(value)) {
    if ("claim" in value) {
      const parts = ["id", "claim", "detail", "question"].map((k) => {
        const v = value[k];
        return typeof v === "string"
          ? v
          : typeof v === "number" || typeof v === "boolean"
            ? v
              ? String(v)
              : ""
            : "";
      });
      yield parts.join(" ").trim();
    } else {
      for (const v of Object.values(value)) yield* strings(v);
    }
  }
}

/** The records of a delivery's content: a hook's output (JSON with the context in `hookSpecificOutput`), a result's text blocks, or plain text. */
export function decode(raw: unknown): string[] {
  if (typeof raw === "string") {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return [...strings(raw)];
    }
    if (isObject(data) && "hookSpecificOutput" in data) {
      const context = (data["hookSpecificOutput"] as Json | null)?.["additionalContext"];
      return [...strings(context === undefined || context === null ? "" : context)];
    }
    return [...strings(data)];
  }
  if (Array.isArray(raw)) {
    return raw.flatMap((block) =>
      decode(isObject(block) && "text" in block ? block["text"] : block),
    );
  }
  return [...strings(raw)];
}

/** What a tool result's JSON says is `degraded`: the answer was made without something, such as the model. */
function degradedOf(raw: unknown): string[] {
  const texts = typeof raw === "string" ? [raw] : blocksOf(raw).map((b) => str(b["text"]));
  for (const text of texts) {
    try {
      const answer = JSON.parse(text) as unknown;
      const degraded = isObject(answer) ? answer["degraded"] : undefined;
      if (Array.isArray(degraded))
        return degraded.filter((x): x is string => typeof x === "string");
    } catch {
      // not JSON: it says nothing was left out
    }
  }
  return [];
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

/** Collects a transcript's events one by one, keeping the line and turn counts. */
class Reader {
  init: Init | undefined;
  readonly deliveries: Delivery[] = [];
  readonly calls: ToolCall[] = [];
  private turn = 0;
  private lastMessage = "";
  private readonly callOf = new Map<string, ToolCall>();

  event(line: number, event: Json): void {
    const message = (event["message"] ?? {}) as Json;
    const content = blocksOf(message["content"]);
    if (event["type"] === "assistant")
      this.assistant(line, str(message["id"], String(line)), content);
    else if (event["type"] === "user") this.results(line, content);
    else if (event["type"] === "system") this.system(line, event);
    else if (event["type"] === "attachment")
      this.attachment(line, (event["attachment"] ?? {}) as Json);
  }

  private push(
    line: number,
    via: Delivery["via"],
    name: string,
    input: Json,
    records: string[],
  ): void {
    const text = records.join("\n");
    if (text.trim() !== "")
      this.deliveries.push({ line, turn: this.turn, via, name, input, text, degraded: [] });
  }

  private system(line: number, event: Json): void {
    if (event["subtype"] === "init") this.init = initOf(event);
    const output = event["output"];
    if (event["subtype"] !== "hook_response" || !output) return;
    const name = str(event["hook_name"]);
    this.push(line, "hook", name, {}, decode(output));
  }

  private attachment(line: number, attachment: Json): void {
    if (!str(attachment["type"]).startsWith("hook")) return;
    const content = attachment["content"] || attachment["stdout"] || "";
    this.push(line, "hook", str(attachment["hookName"]), {}, decode(content));
  }

  private assistant(line: number, id: string, content: Json[]): void {
    if (id !== this.lastMessage) this.turn += 1;
    this.lastMessage = id;
    for (const block of content.filter((b) => b["type"] === "tool_use")) {
      const call: ToolCall = {
        line,
        turn: this.turn,
        id: str(block["id"]),
        name: str(block["name"]),
        input: (block["input"] ?? {}) as Record<string, unknown>,
      };
      this.calls.push(call);
      this.callOf.set(call.id, call);
    }
  }

  private results(line: number, content: Json[]): void {
    for (const block of content.filter((b) => b["type"] === "tool_result")) {
      const call = this.callOf.get(str(block["tool_use_id"]));
      if (call === undefined) continue;
      this.deliveries.push({
        line,
        turn: call.turn,
        via: "tool",
        name: call.name,
        input: call.input,
        text: decode(block["content"]).join("\n"),
        degraded: degradedOf(block["content"]),
      });
    }
  }
}

/** The transcript of one step. A line that does not parse is not counted. */
export function parseTranscript(text: string): Transcript {
  const reader = new Reader();
  let line = 0;
  for (const raw of text.split("\n")) {
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    line += 1;
    if (isObject(event)) reader.event(line, event);
  }
  return {
    init: reader.init,
    deliveries: reader.deliveries.filter((d) => d.text.trim() !== ""),
    calls: reader.calls,
  };
}
