import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { lockOwner, processRuns } from "../src/index.ts";

const root = await mkdtemp(join(tmpdir(), "uketsugi-owner-"));
afterAll(() => rm(root, { recursive: true, force: true }));

test("a note's process runs here, is gone, or cannot be seen from this machine", async () => {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((ended) => child.on("exit", ended));

  expect(processRuns({ pid: process.pid, host: hostname() })).toBe(true);
  expect(processRuns({ pid: child.pid ?? 0, host: hostname() })).toBe(false);
  // Another host's process, no note, and a note that names no process say nothing either way.
  expect(processRuns({ pid: process.pid, host: "another-host" })).toBeNull();
  expect(processRuns(null)).toBeNull();
  expect(processRuns({ host: hostname() })).toBeNull();
});

test("the lock's note is read as the process that took the lock, and is nothing where it is missing or unreadable", async () => {
  const [written, broken, none] = ["written", "broken", "none"].map((name) => join(root, name));
  for (const dir of [written, broken]) await mkdir(dir ?? "");
  await writeFile(join(written ?? "", "lock.owner"), JSON.stringify({ pid: 7, host: "h" }));
  await writeFile(join(broken ?? "", "lock.owner"), "{ not json");

  expect(await lockOwner(written ?? "")).toEqual({ pid: 7, host: "h" });
  expect(await lockOwner(broken ?? "")).toBeNull();
  expect(await lockOwner(none ?? "")).toBeNull();
});
