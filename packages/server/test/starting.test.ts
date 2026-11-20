import { afterEach, describe, expect, test } from "vitest";
import {
  composeServer,
  hostProof,
  listenStarting,
  openLocalPorts,
  type Starting,
} from "../src/index.ts";

/**
 * The server listens before its store is open and answers what it is doing, and the same
 * listener serves once it is. The state is the test's to set, so no case waits on a clock.
 */
const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

const KEY = "host-key";

/** A listener that is closed after the test, unless a server takes it over: that closes it. */
async function listening(state: { now: Starting }, takenOver = false) {
  const starting = await listenStarting({ port: 0, hostKey: KEY, state: () => state.now });
  if (!takenOver) closing.push(() => starting.close());
  return starting;
}

describe("a server whose store is not open", () => {
  test("says on /healthz that it is starting, and tells a client when to ask again", async () => {
    const starting = await listening({ now: { status: "starting" } });

    const response = await fetch(`${starting.url}/healthz`);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({ status: "starting" });
  });

  test("says how far a recovery has got, as its state changes", async () => {
    const state: { now: Starting } = {
      now: { status: "recovering", phase: "syncing", synced: 3, of: 2000 },
    };
    const starting = await listening(state);
    const body = async (): Promise<unknown> => (await fetch(`${starting.url}/healthz`)).json();

    expect(await body()).toEqual({ status: "recovering", phase: "syncing", synced: 3, of: 2000 });
    state.now = { status: "recovering", phase: "replaying", synced: 2100, of: null };
    expect(await body()).toEqual({
      status: "recovering",
      phase: "replaying",
      synced: 2100,
      of: null,
    });
  });

  test("answers /mcp with a JSON-RPC error that says what it is doing", async () => {
    const starting = await listening({
      now: { status: "recovering", phase: "syncing", synced: 3, of: 2000 },
    });

    const response = await fetch(`${starting.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} }),
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      jsonrpc: string;
      id: number;
      error: { message: string };
    };
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 7 });
    expect(body.error.message).toContain("recovering its store after an unclean stop");
    expect(body.error.message).toContain("3 of about 2000");
  });

  test("still proves it is its host's server, for the verbs that ask before they trust an address", async () => {
    const starting = await listening({ now: { status: "starting" } });

    const response = await fetch(`${starting.url}/api/host-proof?challenge=${"ab".repeat(32)}`);

    expect(await response.json()).toEqual({ proof: hostProof(KEY, "ab".repeat(32)) });
  });

  test("refuses a request for any other route in the one error shape", async () => {
    const starting = await listening({ now: { status: "starting" } });

    const response = await fetch(`${starting.url}/api/capabilities`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "unavailable" } });
  });

  test("serves from the same listener once the store is open", async () => {
    const starting = await listening({ now: { status: "starting" } }, true);
    const opened = await openLocalPorts({});
    closing.push(() => opened.close());
    const server = composeServer({ ports: opened.ports });
    closing.push(() => server.close());

    const listener = server.takeOver(starting);
    const response = await fetch(`${starting.url}/healthz`);

    expect(listener.url).toBe(starting.url);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });
});
