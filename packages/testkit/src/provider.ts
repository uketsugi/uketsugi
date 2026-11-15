/**
 * A stand-in for a model provider's API, served on this machine: it keeps what it was sent and
 * answers what a test tells it to. The model runner is tested against it, in each provider's own
 * API shape, so no key is used and no request leaves the machine.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A request as the stand-in received it. */
export interface ProviderRequest {
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Record<string, unknown>;
}

export interface FakeProvider {
  /** The base URL to configure a model with. */
  readonly url: string;
  /** Every request received, in order. */
  readonly received: ProviderRequest[];
  /** Sets what each request from now on is answered with: a status and a JSON body. */
  answerWith(answer: (request: ProviderRequest) => { status?: number; body: object }): void;
  close(): Promise<void>;
}

/** Starts a stand-in provider on a free port. Until told otherwise it answers 500. */
export async function startFakeProvider(): Promise<FakeProvider> {
  const received: ProviderRequest[] = [];
  let answer: Parameters<FakeProvider["answerWith"]>[0] = () => ({ status: 500, body: {} });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const asked = { path: request.url ?? "", headers: request.headers, body };
      received.push(asked);
      const { status = 200, body: said } = answer(asked);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(said));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    answerWith(next) {
      answer = next;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** What a request to OpenAI's chat API asked: the system's words and the user's. */
export function chatAsked(request: ProviderRequest): { system: string; user: string } {
  const messages = request.body["messages"] as { role: string; content: string }[];
  const said = (role: string): string =>
    messages.find((message) => message.role === role)?.content ?? "";
  return { system: said("system"), user: said("user") };
}

/** The body OpenAI's chat API answers with when the model said `content`, for 120 tokens in and 9 out. */
export function chatCompletion(content: string): object {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "local-test",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 9, total_tokens: 129 },
  };
}
