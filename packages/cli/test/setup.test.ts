import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { SERVER_NAME } from "@uketsugi/server";
import { resolveHome } from "../src/home.ts";
import { main } from "../src/index.ts";
import type { Report } from "../src/report.ts";
import { unitText } from "../src/service.ts";
import { setup } from "../src/setup.ts";
import { uninstall } from "../src/uninstall.ts";
import { account } from "./machine.ts";

const LAUNCHER = "/opt/uketsugi/bin/ukt";
const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );
const partOf = (report: Report, id: string): unknown =>
  (report.data["parts"] as { id: string }[]).find((part) => part.id === id);

const MANAGED = { manager: true, linger: "no" } as const;

describe("ukt setup on a machine with a service manager", () => {
  test("with nobody to ask, does what it always did and leaves the service alone", async () => {
    const { dataDir, machine, env, io, options } = await account(MANAGED);

    const report = await setup(io(), options, env);

    expect(report.failure).toBeUndefined();
    expect(report.data).toMatchObject({ created: { data_dir: true, token: true } });
    expect(machine.changes).toEqual([]);
    expect(await exists(machine.unitFile)).toBe(false);
    expect(partOf(report, "service")).toMatchObject({
      state: "skipped",
      lines: [
        `not done: nobody was at the terminal to ask. \`ukt setup --yes --data-dir ${dataDir}\` does it, and \`--plan\` shows it first.`,
      ],
    });
    // Nothing runs the server, so the next step is to start it by hand.
    expect(report.lines).toContain(`Start the server:  ukt serve --data-dir ${dataDir}`);
    expect(report.lines.join("\n")).toContain("prints what to type for each harness");
  });

  test("--plan shows the one file it writes outside the data directory, the unit in full, and changes nothing", async () => {
    const { dataDir, machine, env, io, options } = await account(MANAGED);

    const report = await setup(io(), { ...options, plan: true }, env);
    const plan = report.lines.join("\n");

    expect(await exists(dataDir)).toBe(false);
    expect(machine.changes).toEqual([]);
    expect(plan).toContain(`data directory  ${dataDir}`);
    expect(plan).toContain(
      `service         write ${machine.unitFile}, enable it (the manager adds a link`,
    );
    expect(plan).toContain(`${dirname(machine.unitFile)}/default.target.wants) and start it.`);
    expect(plan).toContain(`                  ExecStart=${LAUNCHER} serve --data-dir ${dataDir}`);
    expect(plan).toContain("                  Restart=on-failure");
    // A server that cannot start is not started for good.
    expect(plan).toContain("                  StartLimitBurst=5");
    // Lingering is off for this account: the plan says what that means and what changes it.
    expect(plan).toContain("loginctl enable-linger (set-up does not change that)");
    // It touches no harness, and the plan names none.
    expect(plan).not.toMatch(/claude mcp|agy |antigravity|plugin/i);
  });

  test("--yes installs the service, ends on the address and what to type, and a second run changes nothing", async () => {
    const { dataDir, machine, origin, env, io, options } = await account(MANAGED);

    const first = await setup(io(), { ...options, yes: true }, env);
    const changes = [...machine.changes];
    const second = await setup(io(), { ...options, yes: true }, env);

    expect(first.failure).toBeUndefined();
    expect(await readFile(machine.unitFile, "utf8")).toBe(
      unitText([LAUNCHER], resolveHome(dataDir, env)),
    );
    expect(changes.filter((line) => line.startsWith("systemctl"))).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable uketsugi.service",
      "systemctl --user reset-failed uketsugi.service",
      "systemctl --user restart uketsugi.service",
    ]);
    expect(machine).toMatchObject({ enabled: true, running: true });
    // Only the manager was spoken to: no harness's program ran.
    expect(machine.ran.every((line) => /^(systemctl|loginctl|journalctl) /.test(line))).toBe(true);
    expect(first.lines).toContain(
      "service         uketsugi.service is enabled and running: it starts when you log in and is started again if it stops",
    );
    expect(first.lines).toContain(
      "server          answers, lists its tools as a harness sees them, and reads its store",
    );
    // The address, then for each harness what to type; no token, since this server asks none here.
    expect(first.lines).toContain(`server URL      ${origin}/mcp`);
    expect(first.lines).toContain(
      "  No harness here needs a token: this server takes one on this machine by its address alone, while you are its only person.",
    );
    expect(first.lines).toContain("  Claude Code");
    expect(first.lines).toContain(
      `    claude mcp add --transport http --scope user ${SERVER_NAME} ${origin}/mcp`,
    );
    expect(first.lines).toContain(`    then type /${SERVER_NAME}:activate in a session`);
    expect(first.lines).toContain(`    agy mcp add ${SERVER_NAME} ${origin}/mcp`);
    expect(first.data).toMatchObject({ needs_token: false });
    // Run again: every part is in place, and nothing but questions is put to the machine.
    expect(machine.changes).toEqual(changes);
    expect(second.data).toMatchObject({ created: { data_dir: false, token: false } });
    expect(partOf(second, "service")).toMatchObject({ state: "running" });
    // No file of a harness's, and nothing of one in the settings.
    expect(JSON.parse(await readFile(join(dataDir, "settings.json"), "utf8"))).not.toHaveProperty(
      "connected",
    );
  });

  test("a person at the terminal is shown the plan and asked once", async () => {
    const { machine, env, io, options } = await account(MANAGED);
    const asked = io({ interactive: true, answer: true });

    await setup(asked, options, env);

    expect(asked.questions).toEqual(["Go ahead?"]);
    expect(asked.errLines.join("\n")).toContain(`write ${machine.unitFile}`);
    expect(machine.running).toBe(true);
  });

  test("backing out of the question changes nothing at all", async () => {
    const { dataDir, machine, env, io, options } = await account(MANAGED);

    const refused = setup(io({ interactive: true, answer: false }), options, env);

    await expect(refused).rejects.toMatchObject({
      failure: { what: "You backed out of set-up.", meaning: "Nothing was changed." },
    });
    expect(await exists(dataDir)).toBe(false);
    expect(machine.changes).toEqual([]);
  });

  test("repairs what is not right: a unit of a release that moved, and a stopped service", async () => {
    const { dataDir, machine, env, io, options } = await account({ manager: true });
    await setup(io(), { ...options, yes: true }, env);
    await writeFile(machine.unitFile, unitText(["/old/ukt"], resolveHome(dataDir, env)));
    await machine.onStop?.();
    machine.running = false;

    const plan = await setup(io(), { ...options, plan: true }, env);
    const repaired = await setup(io(), { ...options, yes: true }, env);

    expect(plan.lines.join("\n")).toContain(
      "which runs another command, and start the server on it",
    );
    expect(repaired.failure).toBeUndefined();
    expect(await readFile(machine.unitFile, "utf8")).toContain(`ExecStart=${LAUNCHER} serve`);
    expect(machine.running).toBe(true);
  });

  test("a server that does not come up leaves no unit to be started for good", async () => {
    const { machine, env, io, options } = await account(MANAGED);
    machine.failing = "restart";

    const report = await setup(io(), { ...options, yes: true }, env);

    expect(report.failure).toMatchObject({
      what: expect.stringContaining("The service was not started") as string,
    });
    expect(machine.changes.at(-1)).toBe("systemctl --user disable --now uketsugi.service");
    expect(machine).toMatchObject({ enabled: false, running: false });
    expect(report.lines).toContain("server          not running");
  });

  test("with its port taken by something else, starts nothing and names --port", async () => {
    const { dataDir, machine, origin, env, io, options } = await account(MANAGED);
    const other = createServer((_request, response) => response.end("{}"));
    const port = Number(new URL(origin).port);
    await new Promise<void>((resolve) => other.listen(port, "127.0.0.1", resolve));

    const report = await setup(io(), { ...options, yes: true }, env).finally(() => other.close());

    expect(report.lines).toContain(
      `service         not running: something that is not this data directory's server is listening at ${origin}. Choose another port: ukt setup --port <port>`,
    );
    expect(await exists(machine.unitFile)).toBe(false);
    expect(machine.changes).toEqual([]);
    // The refused port is not kept, and the next step is the one that can work.
    expect(await exists(join(dataDir, "settings.json"))).toBe(false);
    expect(report.failure?.next).toBe("Choose another port: ukt setup --port <port>");
    expect(report.lines.join("\n")).not.toContain("Start the server:");
  });

  test("with a server of its own started by hand, says to stop that one first", async () => {
    const { machine, env, io, options, byHand } = await account({ ...MANAGED, real: true });
    await byHand();

    const report = await setup(io(), { ...options, yes: true }, env);

    expect(report.failure?.next).toBe(
      "Stop it (Ctrl-C in its terminal), then run `ukt setup` again",
    );
    expect(machine.changes).toEqual([]);
  });

  test("says that the service does not see a model directory the shell names", async () => {
    const { env, io, options } = await account(MANAGED);

    const plan = await setup(
      io(),
      { ...options, plan: true },
      { ...env, UKT_MODEL_DIR: "/elsewhere" },
    );

    expect(plan.lines.join("\n")).toContain(
      "UKT_MODEL_DIR names /elsewhere, which the service does not see",
    );
  });
});

describe("ukt setup where there is no service manager", () => {
  test("says so and what to do instead, asks nothing, and prints what to type once the server runs", async () => {
    const { dataDir, machine, origin, env, io, options, byHand } = await account();
    const noBus = await account({ manager: false });
    const asked = io({ interactive: true });

    const report = await setup(asked, options, env);
    const second = await setup(noBus.io(), noBus.options, noBus.env);
    await byHand();
    const served = await setup(io(), { ...options, yes: true }, env);

    expect(asked.questions).toEqual([]);
    expect(report.lines).toContain(
      `service         none: this machine has no systemd. The server runs while \`ukt serve --data-dir ${dataDir}\` does:`,
    );
    expect(report.lines).toContain(`Start the server:  ukt serve --data-dir ${dataDir}`);
    expect(second.lines.join("\n")).toContain(
      "none: no systemd user manager answers in this shell (one entered with `su` or `sudo` cannot reach yours).",
    );
    expect(noBus.machine.changes).toEqual([]);
    expect(machine.changes).toEqual([]);
    // A server that runs by hand is asked all the same what a harness must send.
    expect(served.lines).toContain(
      `    claude mcp add --transport http --scope user ${SERVER_NAME} ${origin}/mcp`,
    );
  });
});

describe("ukt uninstall", () => {
  test("shows what it will undo, asks, and leaves the data directory, naming how a harness takes the server out", async () => {
    const { dataDir, machine, env, io, options } = await account(MANAGED);
    await setup(io(), { ...options, yes: true }, env);

    const unasked = await uninstall(io(), { dataDir }, env).catch((error: unknown) => error);
    const stillThere = await exists(machine.unitFile);
    const asked = io();
    const removed = await uninstall(asked, { dataDir, yes: true }, env);
    const again = await uninstall(io(), { dataDir, yes: true }, env);

    expect(unasked).toMatchObject({ failure: { meaning: "Nothing was changed." } });
    expect(stillThere).toBe(true);
    expect(asked.errLines).toEqual([
      "This takes uketsugi out of what `ukt setup` put it in:",
      `  the service: uketsugi.service is stopped and disabled, and ${machine.unitFile} is deleted`,
      `The data directory, ${dataDir}, and the release are not touched.`,
    ]);
    expect(removed.failure).toBeUndefined();
    expect(removed.lines).toEqual([
      "removed: the service",
      "A harness you added the server to keeps it, and set-up never touched it. To take it out:",
      `  Claude Code: claude mcp remove ${SERVER_NAME} -s user`,
      `  Antigravity: agy mcp remove ${SERVER_NAME}`,
      `  Codex: codex mcp remove ${SERVER_NAME}`,
      "Your data and the program are as they were. To delete them as well:",
      `  rm -rf ${dataDir} /opt/uketsugi`,
      "and the `ukt` command the install script made: ~/.local/bin/ukt, unless it was told another place.",
    ]);
    expect(await exists(machine.unitFile)).toBe(false);
    // The directories set-up made for it go too, once empty.
    expect(await exists(dirname(machine.unitFile))).toBe(false);
    expect(machine).toMatchObject({ enabled: false, running: false });
    expect(await exists(join(dataDir, "token"))).toBe(true);
    expect(again.lines[0]).toBe("Nothing to undo: no service runs this data directory.");
  });
});

describe("the ukt program's set-up verbs", () => {
  test("parse their flags", async () => {
    const { dataDir, machine, env, io, options, byHand } = await account(MANAGED);
    const run = (...argv: string[]) => main([...argv, "--data-dir", dataDir], io(), env);

    expect(await run("setup", "--no-model", "--no-service", "--port", options.port)).toBe(0);
    await byHand();
    expect(machine.changes.filter((line) => line.startsWith("systemctl"))).toEqual([]);
    expect(await run("setup", "--no-model", "--plan")).toBe(0);
    expect(await run("setup", "--no-model", "--harness", "claude-code")).toBe(1);
    expect(await run("uninstall", "--yes")).toBe(0);
  });
});
