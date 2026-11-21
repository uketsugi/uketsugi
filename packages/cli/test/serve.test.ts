import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectMcp } from "@uketsugi/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { doctor } from "../src/doctor.ts";
import { token } from "../src/host-verbs.ts";
import { exportFacts, ui } from "../src/remote-verbs.ts";
import type { Report } from "../src/report.ts";
import { serve, type Serving } from "../src/serve.ts";
import { backup, restore } from "../src/store-verbs.ts";
import { fakeIo } from "./support.ts";

const PROJECT = "github.com/acme/billing-service";

describe("ukt serve on a temporary data directory", () => {
  let root: string;
  let dataDir: string;
  let serving: Serving;
  let url: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ukt-serve-"));
    dataDir = join(root, "data");
    const options = { dataDir, host: "127.0.0.1", port: "0", taskLeaseMinutes: "2" };
    serving = await serve(fakeIo(), options, {});
    url = serving.report.data["url"] as string;
  });

  afterAll(async () => {
    await serving.close();
    await rm(root, { recursive: true, force: true });
  });

  test("answers, and says where it listens and that no model is installed", async () => {
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect(serving.report.lines[0]).toBe(`uketsugi is serving ${url}/mcp`);
    expect(serving.report.lines.join("\n")).toContain("model: none installed");
    expect(JSON.parse(await readFile(join(dataDir, "server.json"), "utf8"))).toEqual({ url });
  });

  test("takes a tool call signed with the token it made", async () => {
    const held = (await token(fakeIo(), { dataDir }, {})).lines[0] ?? "";
    const client = await connectMcp({ url: `${url}/mcp`, token: held });

    const published = await client.callTool("publish_fact", {
      project: PROJECT,
      claim: "Invoice webhooks retry five times",
      citations: ["src/webhooks/retry.ts:10-42"],
    });
    await client.close();

    expect(published.isError).toBe(false);
  });

  test("holds a claimed task for as long as --task-lease-minutes says", async () => {
    const held = (await token(fakeIo(), { dataDir }, {})).lines[0] ?? "";
    const client = await connectMcp({ url: `${url}/mcp`, token: held });
    const asked = Date.now();
    const task = { project: PROJECT, title: "Check how long a lease lasts", claim: true };
    const published = await client.callTool("publish_task", task);
    await client.close();
    const view = published.structuredContent?.task as { lease_expires_at: string };
    const lasts = Date.parse(view.lease_expires_at) - asked;
    expect(lasts).toBeGreaterThan(110_000);
    expect(lasts).toBeLessThan(180_000);
  });

  test("passes ukt doctor, which warns only that the model is missing", async () => {
    const report = await doctor(fakeIo(), { dataDir }, {});

    expect(report.failure).toBeUndefined();
    expect(report.data["findings"]).toEqual([
      { check: "data directory", state: "ok", detail: dataDir },
      { check: "token", state: "ok", detail: join(dataDir, "token") },
      expect.objectContaining({ check: "service", state: "ok" }),
      expect.objectContaining({ check: "server", state: "ok" }),
      {
        check: "store",
        state: "ok",
        detail: "answers and accepts the token: 1 project, 1 fact",
      },
      expect.objectContaining({ check: "model", state: "warn", fix: "ukt setup" }),
      {
        check: "language model",
        state: "ok",
        detail: "none configured: no model reads a session, and nothing is sent to a provider",
      },
      expect.objectContaining({ check: "jobs", state: "ok" }),
      expect.objectContaining({ check: "harnesses", state: "ok" }),
    ]);
  });

  test("ukt doctor fails a data directory others can read, without saying agents are cut off", async () => {
    // What a container's data folder looks like when its image made it with the usual mode.
    await chmod(dataDir, 0o755);
    const report = await doctor(fakeIo(), { dataDir }, {}).finally(() => chmod(dataDir, 0o700));

    expect(report.failure).toEqual({
      what: "1 of 9 checks failed.",
      meaning:
        "Agents reach their memory all the same: what failed is how it is kept on this machine.",
      next: "Apply each fix above, then run `ukt doctor` again.",
    });
    expect(report.lines).toContain(`      fix: chmod 700 ${dataDir}`);
  });

  test("gives ukt ui a link that signs a browser in once", async () => {
    const io = fakeIo({ interactive: true });

    const opened = await ui(io, { dataDir, open: true }, {});
    const printed = await ui(io, { dataDir, open: false }, {});
    const first = await fetch(io.opened[0] ?? "", { redirect: "manual" });
    const again = await fetch(io.opened[0] ?? "", { redirect: "manual" });

    expect(opened.data).toMatchObject({ opened: true });
    expect(printed.lines[0]).toMatch(new RegExp(`^${url}/sign-in\\?code=`));
    expect(io.opened).toHaveLength(1);
    expect(first.status).toBe(303);
    expect(first.headers.get("set-cookie")).toContain("ukt_session_");
    expect(again.status).toBe(401);
  });

  test("exports each project as a Markdown file named by its key", async () => {
    const folder = join(root, "export");

    const report = await exportFacts({ dataDir, markdown: folder }, {});

    const file = join(folder, `${PROJECT}.md`);
    expect(report.data["files"]).toEqual([
      { project: PROJECT, file, bytes: expect.any(Number) as number },
    ]);
    expect(await readFile(file, "utf8")).toContain("Invoice webhooks retry five times");
  });

  test("takes a backup through the running server, which goes on serving", async () => {
    const file = join(root, "while-serving.tgz");

    const saved = await backup({ dataDir, out: file }, {});

    expect(saved.data).toEqual({ file, bytes: (await stat(file)).size, while_serving: true });
    // A snapshot holds every person's text: wherever it is written, only its owner reads it.
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(saved.data["bytes"]).toBeGreaterThan(1000);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    // The snapshot is the host's alone: it takes the host's own secret, which is not the token
    // a harness is given and is printed by no verb.
    expect((await fetch(`${url}/api/backup`)).status).toBe(403);
    const held = (await token(fakeIo(), { dataDir }, {})).lines[0] ?? "";
    const byToken = await fetch(`${url}/api/backup`, {
      headers: { authorization: `Bearer ${held}` },
    });
    expect(byToken.status).toBe(403);
    expect((await stat(join(dataDir, "host.key"))).mode & 0o777).toBe(0o600);
  });

  test("token --rotate goes through the running server: the new token works at once, the old one is refused, and the server keeps serving", async () => {
    const old = (await token(fakeIo(), { dataDir }, {})).lines[0] ?? "";
    const reach = (bearer: string) =>
      fetch(`${url}/api/projects`, { headers: { authorization: `Bearer ${bearer}` } });

    const rotated = await token(fakeIo(), { dataDir, rotate: true, yes: true }, {});
    const fresh = rotated.lines[0] ?? "";

    expect(rotated.data).toEqual({ token: fresh, revoked: 1 });
    expect(rotated.lines.slice(1, 3)).toEqual([
      "Every earlier token of yours has stopped working.",
      "The server is running, with the new token.",
    ]);
    expect(rotated.lines.join("\n")).not.toContain("Start the server again");
    expect((await reach(old)).status).toBe(401);
    expect((await reach(fresh)).status).toBe(200);
    expect((await token(fakeIo(), { dataDir }, {})).lines[0]).toBe(fresh);
  });

  test("token --rotate run several times at once leaves one working token, and any run whose token was replaced says so", async () => {
    const reach = (bearer: string) =>
      fetch(`${url}/api/projects`, { headers: { authorization: `Bearer ${bearer}` } });

    const runs = await Promise.allSettled(
      Array.from({ length: 4 }, () => token(fakeIo(), { dataDir, rotate: true, yes: true }, {})),
    );
    const printed = runs.flatMap((run) => (run.status === "fulfilled" ? [run.value.lines[0]] : []));
    const live = await Promise.all(printed.map((t) => reach(t ?? "")));
    const onFile = (await token(fakeIo(), { dataDir }, {})).lines[0] ?? "";

    expect(live.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
    // A file that holds a refused token is never left behind by runs that all said they succeeded.
    if ((await reach(onFile)).status !== 200)
      expect(runs.some((run) => run.status === "rejected")).toBe(true);
    for (const run of runs)
      if (run.status === "rejected")
        expect(run.reason).toMatchObject({
          failure: { what: expect.stringContaining("Another `ukt token --rotate`") as string },
        });
  });

  test("refuses the verbs that need the store to themselves, and says to stop it first", async () => {
    const stopFirst = {
      failure: {
        what: `The server is running on this data directory (at ${url}).`,
        next: expect.stringContaining("Stop `ukt serve`") as string,
      },
    };

    await expect(
      restore(fakeIo(), join(dataDir, "token"), { dataDir, yes: true }, {}),
    ).rejects.toMatchObject(stopFirst);
    await expect(
      serve(fakeIo(), { dataDir, host: "127.0.0.1", port: "0" }, {}),
    ).rejects.toMatchObject({ failure: { next: "Use the running server, or stop it first." } });
  });
});

describe("with the server stopped", () => {
  let root: string;
  let dataDir: string;
  let saved: Report;
  let restored: Report;

  // Each step that opens the store on disk has a hook of its own: every one is engine work.
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ukt-store-"));
    dataDir = join(root, "data");
    const serving = await serve(fakeIo(), { dataDir, host: "127.0.0.1", port: "0" }, {});
    await serving.close();
  });
  beforeAll(async () => {
    saved = await backup({ dataDir, out: join(root, "first.tgz") }, {});
  });
  beforeAll(async () => {
    restored = await restore(fakeIo(), join(root, "first.tgz"), { dataDir, yes: true }, {});
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("backup wrote the store to one file and said how to restore it", async () => {
    const file = join(root, "first.tgz");
    expect(saved.data).toEqual({ file, bytes: (await stat(file)).size, while_serving: false });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(saved.lines[1]).toBe(`Restore it with: ukt restore ${file}`);
  });

  test("restore put the snapshot back and kept a copy of what it replaced", async () => {
    const kept = restored.data["kept"] as string;
    expect(kept).toMatch(/backups\/before-restore-\d{8}T\d{6}Z\.tgz$/);
    expect((await stat(kept)).size).toBeGreaterThan(1000);
    expect(restored.lines).toContain(
      `Start the server again with: ukt serve --data-dir ${dataDir}`,
    );
  });

  test("a server shared with other machines says the address they use, or that none can reach it yet", async () => {
    /** The status of `/healthz` asked for under a name, as a request from another machine carries it. */
    const statusUnder = (name: string, port: number) =>
      new Promise<number>((resolve, reject) => {
        const asked = get({ host: "127.0.0.1", port, path: "/healthz", headers: { host: name } });
        asked.on("response", (response) => resolve(response.statusCode ?? 0)).on("error", reject);
      });
    const listen = { dataDir, host: "0.0.0.0", port: "0" };

    const named = await serve(fakeIo(), { ...listen, allowedHost: ["box.lan"] }, {});
    const port = Number(new URL(named.report.data["url"] as string).port);
    const answers = [await statusUnder(`box.lan:${port}`, port), await statusUnder("other", port)];
    await named.close();
    expect(named.report.lines.slice(0, 2)).toEqual([
      `uketsugi is serving http://127.0.0.1:${port}/mcp`,
      `other machines: http://box.lan:${port}/mcp, or the address of a proxy in front of it`,
    ]);
    expect(answers).toEqual([200, 403]);
    expect(named.report.lines).toContain(
      "harnesses: each sends a token, because this server listens beyond this machine.",
    );

    const unnamed = await serve(fakeIo(), listen, {});
    await unnamed.close();
    expect(unnamed.report.lines.slice(1, 3)).toEqual([
      "other machines: none can reach it yet, because it answers only to names it is told.",
      "  Start it with the name they will use: --allowed-host <name>",
    ]);

    // A server for this machine alone says nothing of other machines, and nothing of a fault
    // where the model was left out.
    const alone = await serve(fakeIo(), { dataDir, host: "127.0.0.1", port: "0" }, {});
    const unsigned = await fetch(`${alone.report.data["url"] as string}/api/facts`);
    await alone.close();
    expect(alone.report.lines.join("\n")).not.toContain("other machines");
    // Its one person's own programs reach it by its address alone, and it says what ends that.
    expect(unsigned.status).toBe(200);
    expect(alone.report.lines.join("\n")).toContain(
      "harnesses: on this machine they need no token while you are this server's only person.",
    );

    // Told to, it takes nobody without a token.
    const strict = { dataDir, host: "127.0.0.1", port: "0", requireToken: true };
    const asking = await serve(fakeIo(), strict, {});
    const refused = await fetch(`${asking.report.data["url"] as string}/api/facts`);
    await asking.close();
    expect(refused.status).toBe(401);
    expect(asking.report.lines).toContain("harnesses: each sends a token (--require-token).");
    expect(alone.report.lines).toContain(
      "model: none installed, so search matches words only. `ukt setup` adds it.",
    );
  });

  test("a server bound to every address says, and records, the loopback URL it answers on", async () => {
    const serving = await serve(fakeIo(), { dataDir, host: "0.0.0.0", port: "0" }, {});
    const url = serving.report.data["url"] as string;
    const checked = await doctor(fakeIo(), { dataDir }, {});
    await serving.close();

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(serving.report.lines[0]).toBe(`uketsugi is serving ${url}/mcp`);
    expect(checked.failure).toBeUndefined();
    expect(checked.lines.join("\n")).toContain(`answers at ${url}`);
  });

  test("token --rotate ends the old token, says which variable to update, and the store serves under the new one", async () => {
    const old = (await token(fakeIo(), { dataDir }, {})).lines[0] ?? "";
    const listen = { dataDir, host: "127.0.0.1", port: "0" };

    const rotated = await token(fakeIo(), { dataDir, rotate: true, yes: true }, { UKT_TOKEN: old });
    const fresh = rotated.lines[0] ?? "";
    const stale = await serve(fakeIo(), listen, { UKT_TOKEN: old }).catch(
      (error: unknown) => error,
    );
    const serving = await serve(fakeIo(), listen, {});
    const url = serving.report.data["url"] as string;
    const projects = (bearer: string) =>
      fetch(`${url}/api/projects`, { headers: { authorization: `Bearer ${bearer}` } });
    const [withOld, withNew] = [await projects(old), await projects(fresh)];
    await serving.close();

    expect(rotated.data).toEqual({ token: fresh, revoked: 1 });
    // A harness stored the token itself: the advice has to say it is given the new one.
    expect(rotated.lines.slice(1)).toEqual([
      "Every earlier token of yours has stopped working.",
      "Next:",
      `  1. Start the server again:  ukt serve --data-dir ${dataDir}`,
      "  2. Give each harness that sends a token the new token. A harness keeps the token it was given, so setting",
      `     UKT_TOKEN is not enough. \`ukt ui --data-dir ${dataDir}\` opens the Connect page, which shows what to run`,
      "     again for each harness.",
      'This shell\'s UKT_TOKEN still holds an old token: export UKT_TOKEN="$(ukt token)"',
    ]);
    expect(stale).toMatchObject({
      failure: {
        what: expect.stringContaining("was revoked") as string,
        meaning: "The server did not start.",
        next: expect.stringContaining("UKT_TOKEN in this shell holds the revoked token") as string,
      },
    });
    expect([withOld.status, withNew.status]).toEqual([401, 200]);
  });
});

describe("ukt serve on a store it cannot open", () => {
  test("says what is wrong and what to do, not what the engine threw", async () => {
    const root = await mkdtemp(join(tmpdir(), "ukt-unreadable-"));
    const dataDir = join(root, "data");
    const options = { dataDir, host: "127.0.0.1", port: "0" };
    await (await serve(fakeIo(), options, {})).close();
    // A copy made as another user leaves the engine's folder closed to this one.
    await chmod(join(dataDir, "pg"), 0o000);
    const failed = await serve(fakeIo(), options, {}).then(
      () => null,
      (error: unknown) => error,
    );
    await chmod(join(dataDir, "pg"), 0o755);
    await rm(root, { recursive: true, force: true });

    expect(failed).toMatchObject({
      failure: {
        what: `The store in ${dataDir} cannot be read and written by this user.`,
        meaning: "The server did not start.",
        next: expect.stringContaining("give this user read and write access") as string,
      },
    });
  });
});
