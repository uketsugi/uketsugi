/**
 * What another edition gives the open server: ports opened with nobody in them, and its own name
 * and its own words for a harness it refuses. The hosted edition is the first such.
 */
import { randomUUID } from "node:crypto";
import type { CapabilityDescriptor } from "@uketsugi/contracts";
import { ToolFailure } from "@uketsugi/core";
import { afterEach, describe, expect, test } from "vitest";
import {
  composeServer,
  openLocalPorts,
  openPorts,
  type HarnessRefusals,
  type UketsugiServer,
} from "../src/index.ts";

const closing: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

/** The person the store has under the local owner's subject, made now from this seed if none was there. */
async function ownerFound(ports: Awaited<ReturnType<typeof openPorts>>["ports"]) {
  const seed = {
    subject: "local:owner",
    displayName: "seed",
    orgId: randomUUID(),
    principalId: randomUUID(),
    audienceId: randomUUID(),
  };
  const before = await ports.store.directory.people(seed.orgId);
  const caller = await ports.store.directory.ensurePrincipal(seed);
  return { before, existed: caller.principalId !== seed.principalId };
}

describe("ports with nobody in them", () => {
  test("openPorts makes no person, where openLocalPorts makes the local owner", async () => {
    const opened = await openPorts({});
    closing.push(() => opened.close());
    const bare = await ownerFound(opened.ports);
    expect(bare.before).toEqual([]);
    expect(bare.existed).toBe(false);

    const local = await openLocalPorts({});
    closing.push(() => local.close());
    expect((await ownerFound(local.ports)).existed).toBe(true);
  });
});

/** A request with no token, as one from this machine would come. */
const asker =
  (server: UketsugiServer) =>
  (path: string, method = "GET") =>
    server.fetch(
      new Request(`http://127.0.0.1${path}`, { method, headers: { host: "127.0.0.1" } }),
    );

describe("an edition's name and its refusals", () => {
  const said = (what: string) => new ToolFailure("unauthorized", { what, meaning: "m", next: "n" });
  const refusals: HarnessRefusals = {
    none: (why) => said(`hosted: no token (${why})`),
    empty: () => said("hosted: empty"),
    unknown: () => said("hosted: unknown"),
    register: () =>
      new ToolFailure("not_found", { what: "hosted: no OAuth", meaning: "m", next: "n" }),
  };

  test("the capabilities name the edition, and a harness with no token is told the edition's words", async () => {
    const local = await openLocalPorts({ requireToken: true });
    closing.push(() => local.close());
    const server = composeServer({ ports: local.ports, edition: { name: "hosted", refusals } });
    closing.push(() => server.close());
    const ask = asker(server);
    const capabilities = (await (await ask("/api/capabilities")).json()) as CapabilityDescriptor;
    expect(capabilities.edition).toBe("hosted");
    const mcp = (await (await ask("/mcp", "POST")).json()) as { error: { what: string } };
    expect(mcp.error.what).toMatch(/^hosted: no token/);
    const register = (await (await ask("/register", "POST")).json()) as { error: { what: string } };
    expect(register.error.what).toBe("hosted: no OAuth");
  });

  test("left out, the edition is the open one", async () => {
    const local = await openLocalPorts({ requireToken: true });
    closing.push(() => local.close());
    const server = composeServer({ ports: local.ports });
    closing.push(() => server.close());
    const ask = asker(server);
    const capabilities = (await (await ask("/api/capabilities")).json()) as CapabilityDescriptor;
    expect(capabilities.edition).toBe("community");
    const register = (await (await ask("/register", "POST")).json()) as { error: { what: string } };
    expect(register.error.what).toBe("This server takes a token, not an OAuth sign-in.");
  });
});
