import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectMcp } from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { token } from "../src/host-verbs.ts";
import { main } from "../src/index.ts";
import { invitePerson, listPeople, removeOne, revokeToken } from "../src/people-verbs.ts";
import { ui } from "../src/remote-verbs.ts";
import { CliFailure } from "../src/report.ts";
import { serve, type Serving } from "../src/serve.ts";
import { backup } from "../src/store-verbs.ts";
import { fakeIo, tempDir } from "./support.ts";

/** The secret printed under a heading of an invitation's lines. */
function secretAfter(lines: readonly string[], heading: string): string {
  return (lines[lines.findIndex((line) => line.startsWith(heading)) + 1] ?? "").trim();
}

describe("the verbs of whoever runs a server several people use", () => {
  let root: string;
  let dataDir: string;
  let serving: Serving;
  let url: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ukt-people-"));
    dataDir = join(root, "data");
    serving = await serve(fakeIo(), { dataDir, host: "127.0.0.1", port: "0" }, {});
    url = serving.report.data["url"] as string;
  });

  afterAll(async () => {
    await serving.close();
    await rm(root, { recursive: true, force: true });
  });

  test("ukt people lists the host's own person alone, and says how to add someone", async () => {
    const report = await listPeople({ dataDir }, {});
    expect(report.lines[0]).toBe("you");
    expect(report.lines[1]).toMatch(
      /^ {2}[0-9a-f-]{36} {2}harness token {2}"issued at first start" {2}made \d{4}-\d\d-\d\d \d\d:\d\dZ {2}last used /,
    );
    // The line it gives works as it stands: a first invitation without the operator's name is refused.
    expect(report.lines.at(-1)).toBe(
      "Nobody else is on this server. Add a person with: ukt invite <name> --operator-name <your name>",
    );
    await expect(invitePerson("carol", { dataDir }, {})).rejects.toMatchObject({
      failure: { next: expect.stringContaining("--operator-name <your name>") as string },
    });
  });

  test("the host's own secret is what these verbs send: no verb prints it, and the harness's token is not it", async () => {
    const secret = (await readFile(join(dataDir, "host.key"), "utf8")).trim();
    expect(secret).toMatch(/^ukh_[0-9a-f]{64}$/);
    const harness = (await token(fakeIo(), { dataDir }, {})).lines[0] ?? "";
    expect(harness).not.toBe(secret);
    const io = fakeIo();
    for (const verb of ["people", "token", "doctor"]) await main([verb, "--data-dir", dataDir], io);
    await ui(io, { dataDir, open: false }, {});
    expect([...io.outLines, ...io.errLines].join("\n")).not.toContain(secret);
    // With the harness's token, the same requests are refused: adding a person, and a sign-in link.
    const asHarness = (path: string) =>
      fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${harness}` } });
    expect((await asHarness("/api/people")).status).toBe(403);
    expect((await asHarness("/api/sign-in-codes")).status).toBe(403);
  });

  test("ukt invite asks for the operator's own name once, then prints a token for the harness and a key for the person", async () => {
    const unnamed = invitePerson("bob", { dataDir }, {});
    await expect(unnamed).rejects.toThrow(CliFailure);
    await expect(unnamed).rejects.toThrow("Whoever runs this server has no name yet.");

    // Until someone joins, the operator's own harnesses reach the server by its address alone.
    expect((await fetch(`${url}/api/facts`)).status).toBe(200);
    const invited = await invitePerson(
      "bob",
      { dataDir, operatorName: "ann", label: "laptop" },
      {},
    );
    expect(invited.lines[0]).toBe("Added bob.");
    expect(invited.lines).toContain(
      "Every harness now sends a token, yours included. If you added one by the server's address",
    );
    expect((await fetch(`${url}/api/facts`)).status).toBe(401);
    const [harness, key] = [
      secretAfter(invited.lines, "Harness token:"),
      secretAfter(invited.lines, "Dashboard key:"),
    ];
    expect(harness).toMatch(/^ukt_[0-9a-f]{48}$/);
    expect(key).toMatch(/^ukp_[0-9a-f]{48}$/);
    expect(invited.lines.join("\n")).toContain("must not go in a harness");
    expect(invited.lines.join("\n")).toContain("Until they do, each is private to them.");
    const client = await connectMcp({ url: `${url}/mcp`, token: harness });
    const found = await client.callTool("search_facts", {
      project: "github.com/acme/api",
      query: "anything",
    });
    await client.close();
    expect(found.isError).toBe(false);
    const signIn = (secret: string) =>
      fetch(`${url}/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: secret }),
      });
    expect((await signIn(key)).status).toBe(204);
    expect((await signIn(harness)).status).toBe(401);

    const listed = await listPeople({ dataDir }, {});
    expect(listed.lines.filter((line) => !line.startsWith("  "))).toEqual(["ann", "bob"]);
    expect(listed.lines.join("\n")).toContain('harness token  "laptop"');
    expect(listed.lines.join("\n")).toContain('dashboard key  "bob\'s dashboard key"');
    expect(listed.lines.join("\n")).not.toContain(harness);
    expect(listed.lines.join("\n")).not.toContain(key);
  });

  test("a name that is taken issues nothing until the command says which credential that person is to get", async () => {
    const taken = invitePerson("Bob", { dataDir }, {});
    await expect(taken).rejects.toThrow("bob is already on this server.");
    await expect(invitePerson("bob", { dataDir, token: true, key: true }, {})).rejects.toThrow(
      "--token and --key were both given.",
    );
    await expect(invitePerson("carol", { dataDir, key: true }, {})).rejects.toThrow(
      "Nobody called carol is on this server.",
    );
    const again = await invitePerson("bob", { dataDir, token: true, label: "desktop" }, {});
    expect(again.lines.join("\n")).not.toContain("Every harness now sends a token");
    expect(again.lines[0]).toBe("Issued to bob, who was here already.");
    expect(secretAfter(again.lines, "Harness token:")).toMatch(/^ukt_/);
    expect(again.lines.join("\n")).not.toContain("Dashboard key");
  });

  test("ukt revoke ends one credential and leaves the others, through the command line as a person types it", async () => {
    const io = fakeIo();
    expect(await main(["people", "--json", "--data-dir", dataDir], io)).toBe(0);
    const { data } = JSON.parse(io.outLines[0] ?? "") as {
      data: { people: { name: string; tokens: { id: string; kind: string; label: string }[] }[] };
    };
    const tokens = data.people.find((person) => person.name === "bob")?.tokens ?? [];
    expect(tokens.map((entry) => [entry.kind, entry.label])).toEqual([
      ["agent", "laptop"],
      ["person", "bob's dashboard key"],
      ["agent", "desktop"],
    ]);
    const [laptop, , desktop] = tokens.map((entry) => entry.id);

    const revoked = await revokeToken(laptop ?? "", { dataDir }, {});
    expect(revoked.lines).toEqual([`${laptop} no longer works. Nothing else was touched.`]);
    expect((await revokeToken(laptop ?? "", { dataDir }, {})).lines).toEqual([
      `${laptop} was revoked already.`,
    ]);
    const listed = (await listPeople({ dataDir }, {})).lines;
    expect(listed.find((line) => line.includes(laptop ?? "x"))).toContain("revoked ");
    expect(listed.find((line) => line.includes(desktop ?? "x"))).toContain("last used never");
    await expect(revokeToken("0000", { dataDir }, {})).rejects.toThrow("No token 0000");
  });

  test("ukt remove takes a person off, ends their credentials, and a server with one person left needs no token again", async () => {
    const harness = (await invitePerson("dave", { dataDir }, {})).lines;
    const [daveToken, daveKey] = [
      secretAfter(harness, "Harness token:"),
      secretAfter(harness, "Dashboard key:"),
    ];
    const asked = fakeIo();
    const refused = await removeOne(asked, "dave", { dataDir }, {}).catch(
      (error: unknown) => error,
    );

    expect(refused).toMatchObject({ failure: { meaning: "Nothing was changed." } });
    expect(asked.errLines.join("\n")).toContain(
      "What they shared stays, under their name. What was private to them stays and nobody can reach it.",
    );
    await expect(removeOne(fakeIo(), "ann", { dataDir, yes: true }, {})).rejects.toThrow(
      "Whoever runs this server cannot be removed from it.",
    );
    await expect(removeOne(fakeIo(), "nobody", { dataDir, yes: true }, {})).rejects.toThrow(
      "Nobody called nobody is on this server.",
    );
    // Three people: removing one leaves two, and every harness still sends a token.
    const first = await removeOne(fakeIo(), "dave", { dataDir, yes: true }, {});
    expect(first.lines[0]).toBe("Removed dave. 2 credentials ended.");
    expect(first.lines[1]).toBe("2 people are on this server: every harness still sends a token.");
    expect((await fetch(`${url}/api/facts`)).status).toBe(401);
    const signIn = (key: string) =>
      fetch(`${url}/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
    expect((await signIn(daveKey)).status).toBe(401);

    const last = await removeOne(fakeIo(), "bob", { dataDir, yes: true }, {});

    expect(last.lines[1]).toBe(
      "Nobody else is on this server: a harness on this machine needs no token again.",
    );
    expect(
      (await listPeople({ dataDir }, {})).lines.filter((line) => !line.startsWith("  ")),
    ).toEqual(["ann", expect.stringContaining("Nobody else is on this server") as string]);
    expect((await fetch(`${url}/api/facts`)).status).toBe(200);
    // A removed person's name stays theirs: shared facts still carry it.
    await expect(invitePerson("Dave", { dataDir }, {})).rejects.toThrow(
      "dave was on this server and was removed.",
    );
    const asDave = await fetch(`${url}/api/facts`, {
      headers: { authorization: `Bearer ${daveToken}` },
    });
    expect(asDave.status).toBe(401);
  });
});

describe("a record left behind by a server that died", () => {
  test("nothing secret is sent to whatever listens on its port now", async () => {
    const dataDir = join(await tempDir(), "data");
    const serving = await serve(fakeIo(), { dataDir, host: "127.0.0.1", port: "0" }, {});
    const harness = (await token(fakeIo(), { dataDir }, {})).lines[0] ?? "";
    const record = await readFile(join(dataDir, "server.json"), "utf8");
    await serving.close();

    // Something else takes the port and answers every request, a proof it cannot know included.
    const heard: string[] = [];
    const impostor = createServer((request, response) => {
      heard.push(`${request.url} ${request.headers.authorization ?? "nothing"}`);
      response.setHeader("content-type", "application/json");
      const itself = { edition: "community", contract_version: "0", features: {}, tools: [] };
      response.end(JSON.stringify({ ...itself, proof: "0".repeat(64), projects: [], people: [] }));
    });
    const { port } = new URL((JSON.parse(record) as { url: string }).url);
    await new Promise<void>((resolve) => impostor.listen(Number(port), "127.0.0.1", resolve));
    await writeFile(join(dataDir, "server.json"), record, { mode: 0o600 });
    try {
      const refused = {
        failure: {
          what: expect.stringMatching(
            /^What answers at .+ is not the server of the data directory/,
          ) as string,
          meaning: expect.stringContaining("Nothing secret was sent to it.") as string,
          next: "Start the server again with `ukt serve`, then run this again.",
        },
      };
      await expect(listPeople({ dataDir }, {})).rejects.toMatchObject(refused);
      await expect(invitePerson("mallory", { dataDir }, {})).rejects.toMatchObject(refused);
      await expect(ui(fakeIo(), { dataDir, open: false }, {})).rejects.toMatchObject(refused);
      await expect(backup({ dataDir, out: join(dataDir, "x.tgz") }, {})).rejects.toMatchObject(
        refused,
      );
      const io = fakeIo();
      expect(await main(["doctor", "--data-dir", dataDir], io)).toBe(1);
      expect(io.outLines.join("\n")).toMatch(/store +.*is not the server of the data directory/);
      // It was asked to prove itself, and for nothing with a credential on it.
      expect(heard.some((asked) => asked.startsWith("/api/host-proof?challenge="))).toBe(true);
      expect(heard.filter((asked) => !asked.endsWith(" nothing"))).toEqual([]);
      const secret = (await readFile(join(dataDir, "host.key"), "utf8")).trim();
      expect(heard.join("\n")).not.toContain(secret);
      expect(heard.join("\n")).not.toContain(harness);
    } finally {
      await new Promise((resolve) => impostor.close(resolve));
    }
  });
});
