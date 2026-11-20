/**
 * A pass-through to a model API that records, for each model call, the usage its response ends with
 * (input, cache_write, cache_read, output) and never a header, so no credential is written. A session
 * is pointed at it with ANTHROPIC_BASE_URL and the server's model step with UKT_LLM_URL. It counts the
 * tokens of a session that is killed before Claude Code reports them. Streaming is passed through as
 * it arrives; the upstream is asked for an uncompressed body so that it can be read.
 */
import { appendFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";

export interface Usage {
  input: number;
  cache_write: number;
  cache_read: number;
  output: number;
}

export interface CallRecord {
  readonly n: number;
  readonly ts: number;
  readonly path: string;
  readonly status: number;
  readonly model: string | null;
  readonly usage: Usage;
}

const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "accept-encoding",
]);

const isModelCall = (method: string, path: string): boolean =>
  method === "POST" &&
  (path.split("?")[0]?.endsWith("/v1/messages") === true || path.includes("generateContent"));

const number = (value: unknown): number => (typeof value === "number" ? value : 0);

/** Reads the final usage out of a response, streamed (server-sent events) or whole (JSON). */
export class UsageReader {
  usage: Usage = { input: 0, cache_write: 0, cache_read: 0, output: 0 };
  model: string | null = null;
  private pending = "";
  private whole = "";

  feed(chunk: string): void {
    this.whole += chunk;
    this.pending += chunk;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.line(line.trim());
  }

  finish(): void {
    this.line(this.pending.trim());
    if (/^[{[]/.test(this.whole)) this.parse(this.whole);
  }

  private line(line: string): void {
    if (line.startsWith("data:")) this.parse(line.slice(5).trim());
  }

  private parse(text: string): void {
    try {
      this.event(JSON.parse(text) as unknown);
    } catch {
      // not JSON: a comment line or a partial body
    }
  }

  private event(event: unknown): void {
    if (Array.isArray(event)) return event.forEach((e) => this.event(e));
    if (typeof event !== "object" || event === null) return;
    const e = event as {
      type?: string;
      message?: unknown;
      usage?: unknown;
      model?: unknown;
      usageMetadata?: Gemini;
      modelVersion?: string;
    };
    const message =
      e.type === "message_start" ? (e.message as { model?: string; usage?: unknown }) : e;
    if (e.type === "message_start" || e.type === "message_delta" || e.type === "message") {
      this.model = typeof message.model === "string" ? message.model : this.model;
      this.anthropic((message.usage ?? e.usage ?? {}) as Counts);
    } else if (e.usageMetadata !== undefined) {
      this.gemini(e.usageMetadata);
      this.model = e.modelVersion ?? this.model;
    }
  }

  private anthropic(u: Counts): void {
    const map = {
      input_tokens: "input",
      cache_creation_input_tokens: "cache_write",
      cache_read_input_tokens: "cache_read",
      output_tokens: "output",
    } as const;
    for (const [from, to] of Object.entries(map)) {
      if (typeof u[from] === "number") this.usage[to] = u[from];
    }
  }

  private gemini(u: Gemini): void {
    const cached = number(u.cachedContentTokenCount);
    this.usage = {
      input: number(u.promptTokenCount) - cached,
      cache_write: 0,
      cache_read: cached,
      output: number(u.candidatesTokenCount) + number(u.thoughtsTokenCount),
    };
  }
}
type Counts = Record<string, number | undefined>;
type Gemini = Counts;

export class Forwarder {
  readonly records: CallRecord[] = [];
  port = 0;
  private count = 0;
  private readonly recorded = new Set<number>();
  private readonly server: Server;

  private constructor(target: URL, logPath: string) {
    this.server = createServer((req, res) => {
      void this.forward(target, logPath, req, res);
    });
  }

  static async start(upstream: string, logPath: string): Promise<Forwarder> {
    const forwarder = new Forwarder(new URL(upstream), logPath);
    await new Promise<void>((resolve) => forwarder.server.listen(0, "127.0.0.1", resolve));
    forwarder.port = (forwarder.server.address() as AddressInfo).port;
    return forwarder;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async forward(
    target: URL,
    logPath: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const path = req.url ?? "/";
    const reader = isModelCall(req.method ?? "", path) ? new UsageReader() : undefined;
    const n = reader === undefined ? 0 : ++this.count;
    const ts = Date.now();
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => !HOP.has(k)),
    ) as Counts;
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = send(
      {
        host: target.hostname,
        port: target.port || undefined,
        method: req.method,
        path,
        headers: {
          ...headers,
          host: target.host,
          "accept-encoding": "identity",
          "content-length": String(body.length),
        },
      },
      (response) => {
        const out = Object.fromEntries(
          Object.entries(response.headers).filter(([k]) => !HOP.has(k)),
        );
        res.writeHead(response.statusCode ?? 502, out);
        response.on("data", (chunk: Buffer) => {
          res.write(chunk);
          reader?.feed(chunk.toString());
        });
        response.once("end", () => res.end());
        response.once("close", () =>
          this.record(reader, { n, ts, path, status: response.statusCode ?? 0 }, logPath),
        );
      },
    );
    upstream.once("error", () => {
      res.writeHead(502).end();
      this.record(reader, { n, ts, path, status: 502 }, logPath);
    });
    res.once("close", () => upstream.destroy());
    upstream.end(body);
  }

  private record(
    reader: UsageReader | undefined,
    head: { n: number; ts: number; path: string; status: number },
    logPath: string,
  ): void {
    if (reader === undefined || this.recorded.has(head.n)) return;
    this.recorded.add(head.n);
    reader.finish();
    const record: CallRecord = {
      ...head,
      path: head.path.split("?")[0] ?? head.path,
      model: reader.model,
      usage: reader.usage,
    };
    this.records.push(record);
    void appendFile(logPath, JSON.stringify(record) + "\n");
  }
}
