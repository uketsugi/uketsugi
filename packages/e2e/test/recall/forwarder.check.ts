/**
 * The forwarder records, for each model call, the usage its response ends with and nothing of the
 * request's headers, for both response shapes the suite meets: Anthropic's streamed events (what a
 * harness session sends) and Gemini's whole JSON (what the server's model step sends). The upstreams
 * here are local stand-ins: no key is used and no request leaves the machine.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeProvider } from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Forwarder } from "../../src/recall/forwarder.ts";
import { modelStepUsd } from "../../src/recall/uketsugi.ts";

let dir = "";
let streaming: Server;
let streamingUrl = "";

const EVENTS = [
  {
    type: "message_start",
    message: {
      model: "claude-haiku-5-5",
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 40,
        output_tokens: 1,
      },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "message_delta", usage: { output_tokens: 57 } },
];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "recall-check-forwarder-"));
  streaming = createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(EVENTS.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
  });
  await new Promise<void>((resolve) => streaming.listen(0, "127.0.0.1", resolve));
  streamingUrl = `http://127.0.0.1:${(streaming.address() as AddressInfo).port}`;
});

afterAll(() => {
  streaming.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("what the forwarder records", () => {
  test("the final usage of a streamed Anthropic response, and no header", async () => {
    const log = join(dir, "anthropic.jsonl");
    const forwarder = await Forwarder.start(streamingUrl, log);

    const response = await fetch(`http://127.0.0.1:${forwarder.port}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "sk-secret-value", "content-type": "application/json" },
      body: JSON.stringify({ model: "haiku", messages: [] }),
    });
    await response.text();
    await forwarder.stop();

    expect(forwarder.records).toHaveLength(1);
    expect(forwarder.records[0]?.usage).toEqual({
      input: 12,
      cache_write: 3,
      cache_read: 40,
      output: 57,
    });
    expect(forwarder.records[0]?.model).toBe("claude-haiku-5-5");
    expect(readFileSync(log, "utf8")).not.toContain("sk-secret-value");
  });

  test("a Gemini response's usage, and the model step's spend from it", async () => {
    const provider = await startFakeProvider();
    provider.answerWith(() => ({
      body: {
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: {
          promptTokenCount: 1000,
          cachedContentTokenCount: 200,
          candidatesTokenCount: 50,
          thoughtsTokenCount: 30,
        },
      },
    }));
    const forwarder = await Forwarder.start(provider.url, join(dir, "gemini.jsonl"));

    await (
      await fetch(`http://127.0.0.1:${forwarder.port}/v1beta/models/m:generateContent`, {
        method: "POST",
        body: JSON.stringify({ contents: [] }),
      })
    ).text();
    await forwarder.stop();
    await provider.close();

    expect(forwarder.records[0]?.usage).toEqual({
      input: 800,
      cache_write: 0,
      cache_read: 200,
      output: 80,
    });
    expect(modelStepUsd(forwarder)).toBeCloseTo((800 * 0.25 + 200 * 0.25 + 80 * 1.5) / 1e6, 10);
  });
});
