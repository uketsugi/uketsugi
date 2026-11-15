import { acceptToken, ModelError } from "@uketsugi/core";
import { connectMcp } from "@uketsugi/testkit";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { composeServer, openLocalPorts, type UketsugiServer } from "../src/index.ts";

const TOKEN = "ukt_test_token_for_the_job_log";
const logged: unknown[] = [];
let local: Awaited<ReturnType<typeof openLocalPorts>>;
let server: UketsugiServer;
let url = "";

beforeAll(async () => {
  const embed = () => Promise.reject(new Error("the model is down"));
  local = await openLocalPorts({ embedder: { model: "down", dims: 384, embed } });
  await acceptToken(local.ports, local.owner, TOKEN, "test");
  server = composeServer({ ports: local.ports, onError: (error) => logged.push(error) });
  ({ url } = await server.listen({ port: 0 }));
});

afterAll(async () => {
  await server.close();
  await local.close();
});

test("a job that fails and will be tried again leaves its reason in the server's log", async () => {
  const client = await connectMcp({ url: `${url}/mcp`, token: TOKEN });
  const published = await client.callTool("publish_fact", {
    project: "github.com/acme/api",
    claim: "The gateway times out after three seconds",
    citations: "src/gateway.ts:9",
  });
  await client.close();
  // The write could not embed the fact and left that to a job; the job fails on the same model.
  await vi.waitFor(() => expect(logged).toHaveLength(1));
  const failure = logged[0] as Error;
  const id = String(published.structuredContent?.id);
  expect(failure.message).toBe(
    `The embed job about ${id} failed on attempt 1; it will be tried again.`,
  );
  expect(failure.cause).toMatchObject({ message: "the model is down" });
});

test("a model that answers badly is one line in the terminal, not a stack", async () => {
  const embed = () => Promise.reject(new ModelError("the model's answer holds no list", false));
  const bad = await openLocalPorts({ embedder: { model: "bad", dims: 384, embed } });
  await acceptToken(bad.ports, bad.owner, TOKEN, "test");
  const printed = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const quiet = composeServer({ ports: bad.ports });
  const { url: at } = await quiet.listen({ port: 0 });
  const client = await connectMcp({ url: `${at}/mcp`, token: TOKEN });
  await client.callTool("publish_fact", {
    project: "github.com/acme/api",
    claim: "The gateway times out after three seconds",
    citations: "src/gateway.ts:9",
  });
  await client.close();
  await vi.waitFor(() => expect(printed).toHaveBeenCalledTimes(1));
  const line: unknown = printed.mock.calls[0]?.[0];
  printed.mockRestore();
  await quiet.close();
  await bad.close();

  expect(line).toMatch(
    /^The embed job about \S+ failed on attempt 1; it .*: the model's answer holds no list\.$/,
  );
});
