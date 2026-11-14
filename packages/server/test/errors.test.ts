import { isApiError } from "@uketsugi/contracts";
import { acceptToken } from "@uketsugi/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { composeServer, openLocalPorts, type UketsugiServer } from "../src/index.ts";

const TOKEN = "ukt_test_token_for_the_error_shape";

describe("every failure the server answers with has the one error shape", () => {
  const reported: unknown[] = [];
  let local: Awaited<ReturnType<typeof openLocalPorts>>;
  let server: UketsugiServer;
  let url = "";

  const send = (path: string, init: RequestInit = {}, signed = true) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: { ...(signed ? { authorization: `Bearer ${TOKEN}` } : {}), ...init.headers },
    });
  /** The status and the body of an answer, which must be the error shape with this code. */
  async function refusal(response: Response, code: string): Promise<number> {
    const body: unknown = await response.json();
    expect(isApiError(body), JSON.stringify(body)).toBe(true);
    expect(body).toMatchObject({ error: { code, retry: false } });
    return response.status;
  }

  beforeAll(async () => {
    local = await openLocalPorts({});
    await acceptToken(local.ports, local.owner, TOKEN, "test");
    // A store whose projects cannot be listed stands in for any fault inside the server.
    const projects = {
      ...local.ports.store.projects,
      listOf: () => Promise.reject(new Error("no disk")),
    };
    const ports = { ...local.ports, store: { ...local.ports.store, projects } };
    server = composeServer({ ports, onError: (error) => reported.push(error) });
    ({ url } = await server.listen({ port: 0 }));
  });

  afterAll(async () => {
    await server.close();
    await local.close();
  });

  test("a request nobody signed, on /api and on /mcp, where it carries the identity's challenge", async () => {
    expect(await refusal(await send("/api/facts", {}, false), "unauthorized")).toBe(401);
    const unsigned = await send("/mcp", { method: "POST" }, false);
    expect(unsigned.headers.get("www-authenticate")).toBe("Bearer");
    expect(await refusal(unsigned, "unauthorized")).toBe(401);
  });

  test("a harness /mcp does not accept is told what is wrong with how it was added, each way that happens", async () => {
    const whatOf = async (response: Response) =>
      ((await response.json()) as { error: { what: string; meaning: string; next: string } }).error;
    const mcp = (authorization?: string) =>
      send("/mcp", { method: "POST", headers: authorization ? { authorization } : {} }, false);
    // Added by its URL alone.
    const none = await mcp();
    expect(none.status).toBe(401);
    expect((await whatOf(none)).what).toBe("This harness sent no token.");
    // Added while the variable its command reads was unset: `Bearer` and nothing after it.
    for (const header of ["Bearer", "Bearer ", "Bearer    "]) {
      const empty = await mcp(header);
      expect(empty.status, header).toBe(400);
      const told = await whatOf(empty);
      expect(told.what).toBe("The Authorization header this harness sent holds no token.");
      expect(told.meaning).toContain("UKT_TOKEN was not set in the shell");
      expect(told.next).toContain('export UKT_TOKEN="$(ukt token)"');
      expect(told.next).toContain("add it again with the command on the dashboard's Connect page");
    }
    // Given a token that has been replaced, or another server's.
    const unknown = await mcp("Bearer ukt_a_token_this_server_never_issued");
    expect(unknown.status).toBe(401);
    expect((await whatOf(unknown)).what).toBe(
      "This server does not know the token this harness sent.",
    );
    // None of them is sent to the dashboard's sign-in: that is the answer /api gives.
    for (const refused of [await mcp(), await mcp("Bearer"), await mcp("Bearer ukt_unknown")]) {
      expect(refused.headers.get("www-authenticate")).toBe("Bearer");
      expect(JSON.stringify(await refused.json())).not.toMatch(/dashboard key|signed in/);
    }
    expect((await whatOf(await send("/api/facts", {}, false))).what).toBe(
      "Nobody is signed in on this request.",
    );
  });

  test("a harness with no token asks to sign in with OAuth, and is told what the server takes", async () => {
    // What Claude Code 2.1.325 shows its person is the answer to this request, whole.
    const asked = await send("/register", { method: "POST", body: "{}" }, false);
    expect(await refusal(asked.clone(), "not_found")).toBe(404);
    const { error } = (await asked.json()) as { error: { what: string; next: string } };
    expect(error.what).toBe("This server takes a token, not an OAuth sign-in.");
    expect(error.next).toContain('export UKT_TOKEN="$(ukt token)"');
  });

  test("a request the guard or a middleware refuses", async () => {
    const foreign = await send("/api/facts", { headers: { origin: "https://evil.example" } });
    expect(await refusal(foreign, "forbidden")).toBe(403);
    const json = { "content-type": "application/json" };
    const malformed = await send("/api/hooks/claude-code", {
      method: "POST",
      body: "{",
      headers: json,
    });
    expect(await refusal(malformed, "invalid_input")).toBe(400);
    // What only a person may do is refused to a token before its body is read.
    const byToken = await send("/api/projects", { method: "POST", body: "{}", headers: json });
    expect(await refusal(byToken, "forbidden")).toBe(403);
    const hook = { hook_event_name: "Stop", session_id: "c-1" };
    const huge = JSON.stringify({ ...hook, last_assistant_message: "x".repeat(300_000) });
    // The server answers before it has read the body, so this connection is not one to use again.
    const once = { ...json, connection: "close" };
    const tooLarge = await send("/api/hooks/claude-code", {
      method: "POST",
      body: huge,
      headers: once,
    });
    expect(await refusal(tooLarge, "invalid_input")).toBe(413);
  });

  test("a query or a body its contract refuses, and a route that does not exist", async () => {
    expect(await refusal(await send("/api/facts?limit=many"), "invalid_input")).toBe(422);
    const noSession = await send("/api/hooks/claude-code", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(await refusal(noSession, "invalid_input")).toBe(422);
    expect(await refusal(await send("/api/nowhere"), "not_found")).toBe(404);
  });

  test("a fault inside the server, which is reported and never described to the caller", async () => {
    const failed = await send("/api/projects");
    expect(await refusal(failed, "internal")).toBe(500);
    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain("no disk");
  });
});
