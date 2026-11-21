import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type * as embed from "@uketsugi/embed";
import { expect, test, vi } from "vitest";
import { setup } from "../src/setup.ts";
import { account } from "./machine.ts";

// The model is a 170 MB download: here it is "installed" by the call that asks for it.
const installed = vi.hoisted(() => ({ yes: false }));
vi.mock("@uketsugi/embed", async (original) => ({
  ...(await original<typeof embed>()),
  verifyModel: () =>
    Promise.resolve(
      installed.yes ? { ok: true, model: "the-model" } : { ok: false, detail: "none" },
    ),
  installModel: () => {
    installed.yes = true;
    return Promise.resolve({ ok: true, fetched: true, model: "the-model" });
  },
}));

/** The model is put in the data directory after the server started: its directory changes then. */
async function installedLater(dataDir: string): Promise<void> {
  installed.yes = true;
  await mkdir(join(dataDir, "model"), { recursive: true });
}

const restarts = (ran: readonly string[]): number =>
  ran.filter((line) => line === "systemctl --user restart uketsugi.service").length;

test("set-up that installs the model on a machine whose service runs without it starts the service again, so it has the model", async () => {
  installed.yes = false;
  const { machine, env, io, options } = await account({ manager: true });
  await setup(io(), { ...options, yes: true }, env);
  const before = restarts(machine.ran);

  const report = await setup(io(), { ...options, model: true, yes: true }, env);

  expect(restarts(machine.ran)).toBe(before + 1);
  expect(report.lines.join("\n")).toContain("the-model, installed");
});

test("set-up that installs the model and is not allowed to restart the service says in its last lines that the server has none and what to type", async () => {
  installed.yes = false;
  const { env, io, options } = await account({ manager: true, real: true });
  await setup(io(), { ...options, yes: true }, env);

  // Nobody is at the terminal and `--yes` was not given: the service is left as it is.
  const report = await setup(io(), { ...options, model: true }, env);

  const server = report.lines.findIndex((line) => line.startsWith("server  "));
  expect(report.lines.slice(server, server + 3).join("\n")).toContain(
    "is running without the model it now has, so search matches words only: systemctl --user restart uketsugi",
  );
});

test("set-up that finds the server with its model says nothing of a restart", async () => {
  installed.yes = false;
  const { env, io, options } = await account({ manager: true });
  await setup(io(), { ...options, yes: true }, env);

  const report = await setup(io(), { ...options, yes: true }, env);

  expect(report.lines.join("\n")).not.toContain("without the model");
});

test("the plan says a service in place starts again for the model that set-up installs", async () => {
  installed.yes = false;
  const { env, io, options } = await account({ manager: true });
  await setup(io(), { ...options, yes: true }, env);

  const plan = await setup(io(), { ...options, model: true, plan: true }, env);

  expect(plan.lines.join("\n")).toContain(
    "is running what was set up before: enable it and start it again, to take up the embedding model.",
  );
});

test("set-up that finds the model installed by an earlier run and the service running without it starts the service again, as it does for a model it installs", async () => {
  installed.yes = false;
  const { machine, env, io, options } = await account({ manager: true, real: true });
  await setup(io(), { ...options, yes: true }, env);
  await installedLater(options.dataDir);
  const before = restarts(machine.ran);

  const plan = await setup(io(), { ...options, model: true, plan: true }, env);
  await setup(io(), { ...options, model: true, yes: true }, env);

  expect(plan.lines.join("\n")).toContain("to take up the embedding model.");
  expect(restarts(machine.ran)).toBe(before + 1);
});

test("set-up restarts the service for a model in place once, and when the server still has none says so and leaves it", async () => {
  installed.yes = false;
  // The server here reads the model directory itself and finds nothing in it, as one whose model does not load.
  const { machine, env, io, options } = await account({ manager: true, real: true });
  await setup(io(), { ...options, yes: true }, env);
  await installedLater(options.dataDir);
  const before = restarts(machine.ran);

  await setup(io(), { ...options, model: true, yes: true }, env);
  const again = await setup(io(), { ...options, model: true, yes: true }, env);

  expect(restarts(machine.ran)).toBe(before + 1);
  expect(again.lines.join("\n")).toContain("is running without the model it now has");
  expect(again.lines.join("\n")).not.toContain("to take up the embedding model");
});
