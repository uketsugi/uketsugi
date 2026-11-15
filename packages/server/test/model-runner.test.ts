/**
 * The model runner against each provider's API shape, served by a stand-in on this machine: what
 * is sent where, how an answer and its cost are read, and what a failure says. No key is used and
 * no request leaves the machine.
 */
import { ModelError, type Chore } from "@uketsugi/core";
import {
  chatCompletion,
  startFakeProvider,
  type FakeProvider,
  type ProviderRequest,
} from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createModelRunner, type ModelProvider } from "../src/model-runner.ts";

const KEY = "sk-test-0123456789";
const CHORE: Chore = {
  step: "test.ask",
  instructions: "Say whether the record is empty. Answer with JSON only.",
  material: JSON.stringify({ said: [{ request: "What retries?", answer: "The queue does." }] }),
  shape: {
    type: "object",
    properties: { empty: { type: "boolean" } },
    required: ["empty"],
    additionalProperties: false,
  },
};
const ANSWER = JSON.stringify({ empty: false });

type Received = ProviderRequest;

/** How each provider's API answers a call that produced `ANSWER` for 120 tokens in and 9 out. */
const REPLIES: Record<ModelProvider, object> = {
  google: {
    candidates: [
      { content: { role: "model", parts: [{ text: ANSWER }] }, finishReason: "STOP", index: 0 },
    ],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 9, totalTokenCount: 129 },
  },
  openai: {
    id: "resp_1",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-test",
    output: [
      {
        type: "message",
        id: "msg_1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: ANSWER, annotations: [] }],
      },
    ],
    usage: { input_tokens: 120, output_tokens: 9, total_tokens: 129 },
  },
  anthropic: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text: ANSWER }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 9 },
  },
  "openai-compatible": chatCompletion(ANSWER),
};

/** Where each provider's API takes a call, the header its key travels in, and where the two texts go. */
const SHAPES: Record<
  ModelProvider,
  { path: string; key: (headers: Received["headers"]) => unknown; texts: (body: never) => unknown }
> = {
  google: {
    path: "/models/gemini-test:generateContent",
    key: (headers) => headers["x-goog-api-key"],
    texts: (body: {
      systemInstruction: { parts: { text: string }[] };
      contents: { parts: { text: string }[] }[];
    }) => [body.systemInstruction.parts[0]?.text, body.contents[0]?.parts[0]?.text],
  },
  openai: {
    path: "/responses",
    key: (headers) => headers.authorization,
    texts: (body: { input: { role: string; content: string | { text: string }[] }[] }) =>
      body.input.map(({ content }) => (typeof content === "string" ? content : content[0]?.text)),
  },
  anthropic: {
    path: "/messages",
    key: (headers) => headers["x-api-key"],
    texts: (body: { system: { text: string }[]; messages: { content: { text: string }[] }[] }) => [
      body.system[0]?.text,
      body.messages[0]?.content[0]?.text,
    ],
  },
  "openai-compatible": {
    path: "/chat/completions",
    key: (headers) => headers.authorization,
    texts: (body: { messages: { content: string }[] }) =>
      body.messages.map((message) => message.content),
  },
};

describe("the model runner", () => {
  let provider: FakeProvider;
  let base: string;
  const received: ProviderRequest[] = [];
  let reply: { status: number; body: object } = { status: 200, body: {} };

  beforeAll(async () => {
    provider = await startFakeProvider();
    base = provider.url;
    provider.answerWith((request) => {
      received.push(request);
      return reply;
    });
  });
  afterAll(() => provider.close());

  const OPERATOR = { orgId: "org-1", principalId: "person-1" };
  const runnerOn = (provider: ModelProvider, model: string) =>
    createModelRunner({ provider, model, apiKey: KEY, baseUrl: base }, OPERATOR);
  const models: [ModelProvider, string][] = [
    ["google", "gemini-test"],
    ["openai", "gpt-test"],
    ["anthropic", "claude-test"],
    ["openai-compatible", "local-test"],
  ];

  test.each(models)(
    "asks %s in its own API's shape, and reads the answer and what it cost",
    async (provider, model) => {
      received.length = 0;
      reply = { status: 200, body: REPLIES[provider] };
      const runner = await runnerOn(provider, model);
      expect(runner).toMatchObject({ kind: "endpoint", name: `${provider} · ${model}` });
      expect(received).toEqual([]);

      const answer = await runner.run(CHORE);
      expect(answer).toEqual({ output: { empty: false }, inputTokens: 120, outputTokens: 9 });
      const [sent] = received;
      const shape = SHAPES[provider];
      expect(received).toHaveLength(1);
      expect(sent?.path).toBe(shape.path);
      expect(String(shape.key(sent?.headers ?? {}))).toContain(KEY);
      // The instructions are the system's words and the record is the user's: data, not orders.
      expect(shape.texts(sent?.body as never)).toEqual([CHORE.instructions, CHORE.material]);
    },
  );

  test("serves the one person who configured it, and nobody else", async () => {
    const runner = await runnerOn("google", "gemini-test");
    expect(runner.serves(OPERATOR)).toBe(true);
    expect(runner.serves({ ...OPERATOR, principalId: "person-2" })).toBe(false);
    expect(runner.serves({ ...OPERATOR, orgId: "org-2" })).toBe(false);
  });

  test("a provider's refusal says its status and reason, never the key or what was sent", async () => {
    const refusal = { code: 401, message: "API key not valid.", status: "UNAUTHENTICATED" };
    reply = { status: 401, body: { error: refusal } };
    const runner = await runnerOn("google", "gemini-test");
    const failure = await runner.run(CHORE).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelError);
    expect(failure).toMatchObject({ retryable: false });
    const said = `${String(failure)} ${JSON.stringify(failure)} ${String((failure as Error).cause)}`;
    expect(said).toContain("status 401");
    expect(said).toContain("API key not valid.");
    expect(said).not.toContain(KEY);
    expect(said).not.toContain("The queue does.");
  });

  test.each(["openai", "openai-compatible"] as const)(
    "a provider that repeats the key it refused, whole or masked, does not carry it out (%s)",
    async (provider) => {
      const echo = `Incorrect API key provided: ${KEY}, or ${KEY.slice(0, 7)}***${KEY.slice(-9)}. See docs`;
      reply = { status: 401, body: { error: { message: echo, type: "invalid_request_error" } } };
      const runner = await runnerOn(provider, "any");
      const failure = await runner.run(CHORE).catch((error: unknown) => error);
      const said = `${String(failure)} ${JSON.stringify(failure)}`;
      expect(said).toContain("status 401");
      expect(said).not.toContain(KEY);
      expect(said).not.toContain(KEY.slice(-9));
      expect(said).not.toContain(KEY.slice(0, 8));
      // What a person needs is left: the provider's words about it.
      expect(said).toContain("Incorrect API key provided");
    },
  );

  test("an answer that is not JSON is a failure asking again would not mend", async () => {
    reply = { status: 200, body: chatCompletion("Sure! Here is what I found.") };
    const asked = (await runnerOn("openai-compatible", "local-test")).run(CHORE);
    await expect(asked).rejects.toMatchObject({ name: "ModelError", retryable: false });
  });

  test("a call that runs out of time may be asked again", async () => {
    reply = { status: 200, body: REPLIES.google };
    const asked = (await runnerOn("google", "gemini-test")).run(CHORE, AbortSignal.abort());
    await expect(asked).rejects.toMatchObject({ name: "ModelError", retryable: true });
  });
});
