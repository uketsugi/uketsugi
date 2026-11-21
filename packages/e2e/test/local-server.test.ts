import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { acceptToken, replaceTokens } from "@uketsugi/core";
import {
  composeServer,
  openLocalPorts,
  startLocalServer,
  type UketsugiServer,
} from "@uketsugi/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const TOKEN = "ukt_test_token_for_the_local_server";

const hasIpv6Loopback = Object.values(networkInterfaces())
  .flat()
  .some((address) => address?.internal === true && address.address === "::1");

describe("a server started with a token that was revoked", () => {
  let dataDir: string;
  let replacement: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "uketsugi-local-"));
    const local = await openLocalPorts({ dataDir });
    await acceptToken(local.ports, local.owner, TOKEN, "given at start");
    replacement = (await replaceTokens(local.ports, local.owner)).token;
    await local.close();
  });

  afterAll(() => rm(dataDir, { recursive: true, force: true }));

  test("is refused by a message that names the token and says how to issue a new one", async () => {
    const refused = startLocalServer({ dataDir, port: 0, token: TOKEN });
    await expect(refused).rejects.toThrow(
      /^The token ukt_test… \("given at start"\) was revoked at .+ Issue a new one with `ukt token --rotate`/,
    );
    await expect(refused).rejects.not.toThrow(TOKEN);
  });

  test("starts with the token that replaced it, on the data directory the refused start let go", async () => {
    const server = await startLocalServer({ dataDir, port: 0, token: replacement });
    try {
      const as = (token: string) =>
        fetch(`${server.url}/api/projects`, { headers: { authorization: `Bearer ${token}` } });
      expect((await as(replacement)).status).toBe(200);
      expect((await as(TOKEN)).status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe("the address a listening server reports", () => {
  let server: UketsugiServer;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const local = await openLocalPorts({});
    server = composeServer({ ports: local.ports });
    close = async () => {
      await server.close();
      await local.close();
    };
  });

  afterAll(() => close());

  test("bound to every address, it is the loopback URL, which the server answers at", async () => {
    const listening = await server.listen({ host: "0.0.0.0", port: 0 });
    expect(listening.url).toBe(`http://127.0.0.1:${listening.port}`);
    expect((await fetch(`${listening.url}/healthz`)).status).toBe(200);
  });

  test.skipIf(!hasIpv6Loopback)(
    "on an IPv6 address, it is a URL with the address in brackets",
    async () => {
      for (const host of ["::1", "[::1]"]) {
        const listening = await server.listen({ host, port: 0 });
        expect(listening.url).toBe(`http://[::1]:${listening.port}`);
        expect(new URL(listening.url).port).toBe(String(listening.port));
        expect((await fetch(`${listening.url}/healthz`)).status).toBe(200);
      }
    },
  );
});
