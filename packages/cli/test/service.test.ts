import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SERVER_NAME } from "@uketsugi/server";
import { doctor, type Finding } from "../src/doctor.ts";
import { token } from "../src/host-verbs.ts";
import type { Report } from "../src/report.ts";
import { serve } from "../src/serve.ts";
import { setup } from "../src/setup.ts";
import { backup, restore } from "../src/store-verbs.ts";
import { account, Machine } from "./machine.ts";
import { fakeIo } from "./support.ts";

const findingsOf = (report: Report, check: string): Finding[] =>
  (report.data["findings"] as Finding[]).filter((finding) => finding.check === check);
const settingsOf = async (dataDir: string): Promise<unknown> =>
  JSON.parse(await readFile(join(dataDir, "settings.json"), "utf8")) as unknown;

/** An account that has run set-up to the end: the service runs the server. */
async function served() {
  const made = await account({ manager: true, linger: "no", real: true });
  return { ...made, report: await setup(made.io(), { ...made.options, yes: true }, made.env) };
}

// The manager of these tests runs the real server, which a test stops and starts again more than
// once: each start is a new engine, a second alone and several beside other test files.
describe("a server that runs as the service", { timeout: 60_000 }, () => {
  test("is what doctor reports, with the commands that stop it, start it and show its log, and what each harness must send", async () => {
    const { dataDir, machine, origin, env, io, report } = await served();

    const running = await doctor(io(), { dataDir }, env);
    await machine.onStop?.();
    machine.running = false;
    const stopped = await doctor(io(), { dataDir }, env);

    expect(running.failure).toBeUndefined();
    expect(report.lines).toContain(
      "server          answers, lists its tools as a harness sees them, and reads its store",
    );
    expect(findingsOf(running, "service")).toEqual([
      {
        check: "service",
        state: "ok",
        detail: "uketsugi.service is enabled and running",
        notes: [
          "stop: systemctl --user stop uketsugi",
          "start: systemctl --user start uketsugi",
          "log: journalctl --user -u uketsugi",
          "it stops when you log out of this machine; to keep it running: loginctl enable-linger",
        ],
      },
    ]);
    expect(running.lines).toContain("      log: journalctl --user -u uketsugi");
    // The server says what a harness here must send, and what to type for each: the same rows the Connect page shows.
    const [harnesses] = findingsOf(running, "harnesses");
    expect(harnesses).toMatchObject({
      state: "ok",
      detail:
        "No harness here needs a token: this server takes one on this machine by its address alone, while you are its only person.",
    });
    expect(harnesses?.notes).toContain(
      `  claude mcp add --transport http --scope user ${SERVER_NAME} ${origin}/mcp`,
    );
    expect(harnesses?.notes).toContain(`  then type /${SERVER_NAME}:activate in a session`);
    expect(findingsOf(stopped, "service")[0]).toMatchObject({
      state: "fail",
      detail: "uketsugi.service is installed and not running: inactive (dead)",
      fix: "systemctl --user start uketsugi",
    });
    // The server is started by its service, so that is the fix for a server that is down.
    expect(findingsOf(stopped, "server")[0]).toMatchObject({
      fix: "systemctl --user start uketsugi",
    });
  });

  test("is, once it gave up after repeated failures, named by doctor with its cause and a fix that clears it", async () => {
    const { dataDir, machine, env, io } = await served();
    await machine.onStop?.();
    machine.running = false;
    machine.gaveUp = true;

    const report = await doctor(io(), { dataDir }, env);

    const [service] = findingsOf(report, "service");
    expect(service).toMatchObject({
      state: "fail",
      detail: expect.stringContaining("failed (failed)") as string,
    });
    expect(service?.fix).toBe(
      "systemctl --user reset-failed uketsugi && systemctl --user start uketsugi, once what the lines below say is put right",
    );
    // Where the user journal holds nothing, it says so and names what shows why.
    expect(service?.notes?.join("\n")).toContain("Run `ukt serve --data-dir");
  });

  test("tells whoever starts a second one by hand what is running and how to stop it", async () => {
    const { dataDir, env, io } = await served();

    const refused = await serve(io(), { dataDir }, env).catch((error: unknown) => error);

    expect(refused).toMatchObject({
      failure: {
        meaning: expect.stringContaining("It runs as your service (uketsugi.service)") as string,
        next: "Use the running server. To run one by hand instead, stop the service first: systemctl --user stop uketsugi",
      },
    });
  });

  test("is stopped for token --rotate and started again with the new token", async () => {
    const { dataDir, machine, env, io } = await served();
    const old = (await token(io(), { dataDir }, env)).lines[0] ?? "";
    const before = machine.changes.length;

    const asked = io();
    const rotated = await token(asked, { dataDir, rotate: true, yes: true }, env);
    const fresh = rotated.lines[0] ?? "";
    const running = await doctor(io(), { dataDir }, env);

    expect(fresh).not.toBe(old);
    expect(asked.errLines).toContain(
      "The server runs as your service (uketsugi.service): it is stopped for this and started again afterwards.",
    );
    expect(machine.changes.slice(before, before + 3)).toEqual([
      "systemctl --user stop uketsugi.service",
      "systemctl --user reset-failed uketsugi.service",
      "systemctl --user start uketsugi.service",
    ]);
    expect(rotated.lines.slice(1, 3)).toEqual([
      "Every earlier token of yours has stopped working.",
      "The service is running again, with the new token.",
    ]);
    // The server that came back accepts the new token: doctor's store check asks with it.
    expect(findingsOf(running, "store")[0]).toMatchObject({ state: "ok" });
  });

  test("is stopped for restore and started again, also when the restore fails", async () => {
    const { dataDir, machine, env, io } = await served();
    const snapshot = String((await backup({ dataDir }, env)).data["file"]);
    const notOne = join(dataDir, "token");

    const restored = await restore(io(), snapshot, { dataDir, yes: true }, env);
    const failed = await restore(io(), notOne, { dataDir, yes: true }, env).catch(
      (error: unknown) => error,
    );
    const after = await doctor(io(), { dataDir }, env);

    expect(restored.lines.at(-1)).toBe("The service is running again, on the restored store.");
    expect(failed).toBeInstanceOf(Error);
    expect(machine.running).toBe(true);
    expect(findingsOf(after, "server")[0]).toMatchObject({ state: "ok" });
  });

  test("is not stopped from a shell that cannot reach its manager: the verb is refused and says where to run it", async () => {
    const { home, dataDir, env } = await served();
    // The same account entered with `su`: its unit is on disk, its manager out of reach.
    const su = fakeIo({ run: new Machine({ home, manager: false }).run });

    const refused = await token(su, { dataDir, rotate: true, yes: true }, env).catch(
      (error: unknown) => error,
    );

    expect(refused).toMatchObject({
      failure: {
        meaning: expect.stringContaining(
          "It runs as your service (uketsugi.service), and no systemd user manager answers in this shell",
        ) as string,
        next: "Run `ukt token --rotate` from a shell of your own login, where `systemctl --user stop uketsugi` works.",
      },
    });
  });
});

describe("what ukt setup is told of how the server runs", () => {
  test("is kept, so that a start with no flags, a person's or the service's, is the same server", async () => {
    const { dataDir, env, io } = await account();
    const options = { dataDir, model: false };
    const told = { ...options, host: "127.0.0.1", port: "0", allowedHost: ["box.lan"] };

    const report = await setup(io(), { ...told, taskLeaseMinutes: "30" }, env);
    const again = await setup(io(), options, env);
    const serving = await serve(io(), { dataDir }, env);
    await serving.close();

    expect(await settingsOf(dataDir)).toEqual({
      host: "127.0.0.1",
      port: "0",
      allowedHost: ["box.lan"],
      taskLeaseMinutes: "30",
    });
    expect((await stat(join(dataDir, "settings.json"))).mode & 0o777).toBe(0o600);
    expect(report.data["mcp_url"]).toBe("http://127.0.0.1:0/mcp");
    // A later set-up that is told nothing keeps what was said.
    expect(again.data["mcp_url"]).toBe("http://127.0.0.1:0/mcp");
    expect(serving.report.lines.join("\n")).toMatch(/other machines: http:\/\/box\.lan:\d+\/mcp/);
    await expect(setup(io(), { ...options, taskLeaseMinutes: "0" }, env)).rejects.toMatchObject({
      failure: { what: '"0" is not a value --task-lease-minutes takes.' },
    });
  });

  test("--require-token is kept, and set-up then says every harness sends a token and lists its tools with one", async () => {
    const { dataDir, origin, env, io, options } = await account({ manager: true, real: true });

    const report = await setup(io(), { ...options, yes: true, requireToken: true }, env);

    expect(report.failure).toBeUndefined();
    expect(await settingsOf(dataDir)).toMatchObject({ requireToken: true });
    expect(report.data).toMatchObject({ needs_token: true });
    expect(report.lines).toContain(
      "server          answers, lists its tools as a harness sees them, and reads its store",
    );
    expect(report.lines).toContain(
      `  Every harness sends a token to this server. In the shell you add them from: export UKT_TOKEN="$(ukt token --data-dir ${dataDir})"`,
    );
    expect(report.lines).toContain(
      `    claude mcp add --transport http --scope user ${SERVER_NAME} ${origin}/mcp --header "Authorization: Bearer $UKT_TOKEN"`,
    );
  });

  test("a change restarts a service that was running what was set up before", async () => {
    const { machine, env, io, options } = await account({ manager: true });
    await setup(io(), { ...options, yes: true }, env);
    const before = machine.changes.length;
    const longer = { ...options, taskLeaseMinutes: "45" };

    const plan = await setup(io(), { ...longer, plan: true }, env);
    await setup(io(), { ...longer, yes: true }, env);

    expect(plan.lines.join("\n")).toContain(
      "uketsugi.service is running what was set up before: enable it and start it again.",
    );
    expect(machine.changes.slice(before)).toContain("systemctl --user restart uketsugi.service");
  });

  test("a second data directory does not take the one unit from the first", async () => {
    const { home, machine, env, io, options } = await account({ manager: true });
    await setup(io(), { ...options, yes: true }, env);
    const unit = await readFile(machine.unitFile, "utf8");
    const second = { dataDir: join(home, "second"), model: false, port: "0", yes: true };

    const report = await setup(io(), second, env);

    expect(report.lines).toContain(
      "service         uketsugi.service is there and serves another data directory: left as it is.",
    );
    expect(await readFile(machine.unitFile, "utf8")).toBe(unit);
  });

  test("settings that cannot be read are refused, and what 0.1.0 recorded of a store elsewhere is still found", async () => {
    const broken = await account();
    const old = await account();
    await mkdir(broken.dataDir);
    await writeFile(join(broken.dataDir, "settings.json"), "{ not json");
    await mkdir(old.dataDir);
    const address = "postgres://ukt:s3cr3t@db.internal:5432/memory";
    await writeFile(join(old.dataDir, "store.json"), JSON.stringify({ databaseUrl: address }));

    const refused = serve(broken.io(), { dataDir: broken.dataDir }, broken.env);
    const elsewhere = backup({ dataDir: old.dataDir }, old.env);

    await expect(refused).rejects.toMatchObject({
      failure: { what: expect.stringContaining("settings.json cannot be read") as string },
    });
    await expect(elsewhere).rejects.toMatchObject({
      failure: { what: "This host's store is the PostgreSQL database db.internal:5432/memory." },
    });
  });
});
