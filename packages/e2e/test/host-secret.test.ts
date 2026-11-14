import type { HostProof, SignInCode } from "@uketsugi/contracts";
import { hostProof, startLocalServer, type LocalServer } from "@uketsugi/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const TOKEN = "ukt_test_token_for_the_host_routes";
const KEY = "ukh_test_secret_of_the_host";

describe("the host's own secret", () => {
  let server: LocalServer;
  const asHost = { authorization: `Bearer ${KEY}` };

  beforeAll(async () => {
    server = await startLocalServer({ port: 0, token: TOKEN, hostKey: KEY, embedder: null });
  });
  afterAll(() => server.close());

  test("a server proves it holds the secret to whoever asks, and shows it to no one", async () => {
    const ask = (challenge: string) =>
      fetch(`${server.url}/api/host-proof?${new URLSearchParams({ challenge }).toString()}`);
    const [one, other] = ["ab".repeat(32), "cd".repeat(32)];
    const answered = await ask(one);
    expect(answered.status).toBe(200);
    const { proof } = (await answered.json()) as HostProof;
    expect(proof).toBe(hostProof(KEY, one));
    expect(proof).not.toBe(hostProof("ukh_another_hosts_secret", one));
    expect(((await (await ask(other)).json()) as HostProof).proof).toBe(hostProof(KEY, other));
    expect(JSON.stringify(proof)).not.toContain(KEY);
    // Only a challenge of random bytes is answered.
    expect((await ask("short")).status).toBe(422);
    expect((await fetch(`${server.url}/api/host-proof`)).status).toBe(422);
  });

  test("the dashboard's cookie is kept to TLS when a proxy in front says the browser came over it", async () => {
    const cookieOf = async (headers: Record<string, string>) => {
      const minted = await fetch(`${server.url}/api/sign-in-codes`, {
        method: "POST",
        headers: asHost,
      });
      const { code } = (await minted.json()) as SignInCode;
      const signedIn = await fetch(`${server.url}/sign-in?code=${code}`, {
        headers,
        redirect: "manual",
      });
      expect(signedIn.status).toBe(303);
      return signedIn.headers.get("set-cookie") ?? "";
    };
    expect(await cookieOf({ "x-forwarded-proto": "https" })).toMatch(/; Secure/);
    expect(await cookieOf({ "x-forwarded-proto": "https, http" })).toMatch(/; Secure/);
    expect(await cookieOf({ forwarded: "for=192.0.2.60;proto=https;by=203.0.113.43" })).toMatch(
      /; Secure/,
    );
    // Reached directly over plain HTTP, as on the host itself, a Secure cookie would never come back.
    const plainly: Record<string, string>[] = [
      {},
      { "x-forwarded-proto": "http" },
      { forwarded: "proto=http" },
    ];
    for (const plain of plainly) {
      const cookie = await cookieOf(plain);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).not.toMatch(/Secure/);
    }
  });
});

test("a server started with an empty host secret has nobody to administer it", async () => {
  const server = await startLocalServer({ port: 0, token: TOKEN, hostKey: "", embedder: null });
  try {
    const send = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, init);
    const json = { "content-type": "application/json" };
    const invite = {
      method: "POST",
      headers: json,
      body: '{"name":"mallory","operator_name":"x"}',
    };
    // A request that sends no credential would equal an empty secret: every way of sending none is refused.
    for (const headers of [{}, { authorization: "Bearer" }, { authorization: "Bearer " }]) {
      const asked = [
        await send("/api/people", { headers }),
        await send("/api/people", { ...invite, headers: { ...json, ...headers } }),
        await send("/api/backup", { headers }),
        await send("/api/sign-in-codes", { method: "POST", headers }),
        await send("/api/host-proof?challenge=" + "ab".repeat(32), { headers }),
      ];
      for (const response of asked) {
        await response.arrayBuffer();
        expect([401, 403, 404], `${response.url} answered ${response.status}`).toContain(
          response.status,
        );
      }
    }
    const health = (await (await send("/healthz")).json()) as Record<string, unknown>;
    expect(health).not.toHaveProperty("jobs");
    // The people are as they were: nobody was added.
    const held = { authorization: `Bearer ${TOKEN}` };
    expect((await send("/api/projects", { headers: held })).status).toBe(200);
  } finally {
    await server.close();
  }
});
