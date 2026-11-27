import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { doctor, type Finding } from "../src/doctor.ts";
import { keepStartFailure, readUpgrade, resolveHome } from "../src/home.ts";
import type { Report } from "../src/report.ts";
import { servingNow } from "../src/server-client.ts";
import { setup } from "../src/setup.ts";
import { backup, restore } from "../src/store-verbs.ts";
import { rollback, upgrade } from "../src/upgrade.ts";
import { restoreEmbeddedStore } from "@uketsugi/store";
import type * as Store from "@uketsugi/store";
import { account } from "./machine.ts";
import { tempDir } from "./support.ts";

// The real restore, watched: what `rollback` asks of it is what a test of the store cannot see.
vi.mock("@uketsugi/store", async (original) => {
  const real = await original<typeof Store>();
  return { ...real, restoreEmbeddedStore: vi.fn(real.restoreEmbeddedStore) };
});

const findingsOf = (report: Report, check: string): Finding[] =>
  (report.data["findings"] as Finding[]).filter((finding) => finding.check === check);

/** A folder shaped like an installed release, whose `VERSION` says what it is. */
async function release(dir: string, version: string): Promise<void> {
  await mkdir(join(dir, "bin"), { recursive: true });
  await writeFile(join(dir, "VERSION"), `uketsugi ${version}\nnode v24\n`);
  await writeFile(join(dir, "bin", "ukt"), "#!/bin/sh\n");
}

/** An account whose service has been set up from the release at `lib`, with the release before it kept beside. */
async function installed() {
  const made = await account({ manager: true, linger: "no", real: true });
  const base = await tempDir();
  const lib = join(base, "uketsugi");
  await release(lib, "0.3.0+abc1234");
  await release(`${lib}.previous`, "0.2.0");
  const env = { ...made.env, UKT_LAUNCHER: join(lib, "bin", "ukt") };
  await setup(made.io(), { ...made.options, yes: true }, env);
  expect(made.machine.running).toBe(true);
  // A server of this test's own process answers late while it is busy.
  await vi.waitFor(
    async () => expect(await servingNow(resolveHome(made.dataDir, env))).not.toBeNull(),
    { timeout: 60_000 },
  );
  return { ...made, lib, env };
}

describe("settling an upgrade that has swapped the release", () => {
  test("restarts the service, waits for its server and records what it did", async () => {
    const { lib, dataDir, machine, env, io } = await installed();
    machine.ran.length = 0;

    const report = await upgrade(io(), { settle: lib, dataDir }, env);

    expect(report.lines[0]).toBe(
      "uketsugi 0.2.0 is now 0.3.0+abc1234. Your service (uketsugi.service) was restarted and answers on it.",
    );
    expect(report.lines[1]).toBe(
      "The store needed no migration. `ukt rollback` brings back 0.2.0.",
    );
    expect(machine.changes).toContain("systemctl --user restart uketsugi.service");
    const record = await readUpgrade(resolveHome(dataDir, env));
    expect(record).toMatchObject({ from: "0.2.0", to: "0.3.0+abc1234", snapshot: null });
    const doctored = await doctor(io(), { dataDir }, env);
    expect(findingsOf(doctored, "upgrade")[0]).toMatchObject({
      state: "ok",
      detail: expect.stringContaining("0.2.0 to 0.3.0+abc1234") as string,
    });
  });

  test("puts the release before back, starts it and says why, when the new server does not start", async () => {
    const { lib, dataDir, machine, env, io } = await installed();
    const works = machine.onStart;
    let starts = 0;
    machine.onStart = (unit) =>
      ++starts === 1
        ? Promise.reject(new Error("the new release cannot open the store"))
        : (works?.(unit) ?? Promise.resolve());

    const failure = (await upgrade(io(), { settle: lib, dataDir }, env).catch(
      (error: unknown) => error,
    )) as { failure: { what: string; meaning: string; next: string } };

    expect(failure.failure.what).toContain("The new release (0.3.0+abc1234) did not start");
    expect(failure.failure.meaning).toBe(
      "The release you had (0.2.0) is back and your service answers on it. Nothing in the store was changed.",
    );
    expect(failure.failure.next).toContain("Run `ukt doctor`, which shows the reason");
    expect(await readFile(join(lib, "VERSION"), "utf8")).toContain("uketsugi 0.2.0");
    expect(await stat(`${lib}.previous`).catch(() => null)).toBeNull();
    expect(machine.running).toBe(true);
    const doctored = await doctor(io(), { dataDir }, env);
    expect(findingsOf(doctored, "upgrade")[0]).toMatchObject({
      state: "warn",
      detail: expect.stringContaining("the earlier one was put back") as string,
    });
  });

  test("starts a service that keeps failing, since a new release may mend it, and leaves one its person stopped", async () => {
    const { lib, dataDir, machine, env, io } = await installed();
    await machine.onStop?.();
    machine.running = false;

    const stopped = await upgrade(io(), { settle: lib, dataDir }, env);
    machine.gaveUp = true;
    const failing = await upgrade(io(), { settle: lib, dataDir }, env);

    expect(stopped.lines[0]).toContain("is not running, so nothing was restarted");
    expect(failing.lines[0]).toContain("was restarted and answers on it");
    expect(machine.running).toBe(true);
  });

  test("does not say it restarted a service it did not, and names what the person must do", async () => {
    const { lib, dataDir, machine, env, io } = await installed();
    const su = io({ run: () => Promise.resolve({ code: 1, stdout: "", stderr: "no bus" }) });
    machine.ran.length = 0;

    const report = await upgrade(su, { settle: lib, dataDir }, env);

    expect(report.lines.join("\n")).toContain("could not be reached from this shell");
    expect(report.lines.join("\n")).toContain("systemctl --user restart uketsugi");
    expect(report.lines.join("\n")).not.toContain("was restarted");
    expect(machine.changes).toEqual([]);
  });
});

describe("going back after an upgrade", () => {
  test("finds the copy of the store that a server started by hand made when it first started on the new release", async () => {
    const { lib, dataDir, env, io } = await installed();
    const home = resolveHome(dataDir, env);
    const su = io({ run: () => Promise.resolve({ code: 1, stdout: "", stderr: "no bus" }) });
    await upgrade(su, { settle: lib, dataDir }, env);
    expect((await readUpgrade(home))?.snapshot).toBeNull();
    // The new release's first start migrated the store, after the upgrade, and kept this copy.
    const made = String((await backup({ dataDir }, env)).data["file"]);
    const copy = join(home.backupsDir, "before-0003_digest_failure.tgz");
    await copyFile(made, copy);

    const asked = io({ interactive: true, answer: false });
    await rollback(asked, { dataDir }, env).catch(() => undefined);

    expect(asked.errLines.join("\n")).toContain(`The store goes back to ${copy} (`);
    const doctored = await doctor(io(), { dataDir }, env);
    expect(findingsOf(doctored, "upgrade")[0]?.detail).toContain(
      `the store from before it: ${copy}`,
    );
  });

  test("restores the store from the migration's copy, puts the release back and starts the service", async () => {
    const { lib, dataDir, machine, env, io } = await installed();
    const home = resolveHome(dataDir, env);
    const copy = String((await backup({ dataDir }, env)).data["file"]);
    await writeFile(
      home.upgradeFile,
      JSON.stringify({
        from: "0.2.0",
        to: "0.3.0+abc1234",
        at: "2026-11-26T10:00:00.000Z",
        previous: `${lib}.previous`,
        snapshot: copy,
      }),
    );
    machine.ran.length = 0;

    const report = await rollback(io(), { dataDir, yes: true }, env);

    expect(report.lines[0]).toContain("Back on 0.2.0.");
    expect(report.lines[0]).toContain(copy);
    expect(report.lines.at(-1)).toBe("The service is running again, on that release.");
    expect(await readFile(join(lib, "VERSION"), "utf8")).toContain("uketsugi 0.2.0");
    expect(await readUpgrade(home)).toBeNull();
    expect(
      machine.changes.filter((line) => /stop|start/.test(line)).map((l) => l.split(" ")[2]),
    ).toContain("stop");
    expect(machine.running).toBe(true);
  });

  test("restores the snapshot at the schema it was taken at, which the release going back needs: an ordinary restore would migrate it to this one's", async () => {
    const { lib, dataDir, env, io } = await installed();
    const home = resolveHome(dataDir, env);
    const copy = String((await backup({ dataDir }, env)).data["file"]);
    await writeFile(
      home.upgradeFile,
      JSON.stringify({
        from: "0.2.0",
        to: "0.3.0+abc1234",
        at: "2026-11-26T10:00:00.000Z",
        previous: `${lib}.previous`,
        snapshot: copy,
      }),
    );
    vi.mocked(restoreEmbeddedStore).mockClear();

    await rollback(io(), { dataDir, yes: true }, env);

    expect(restoreEmbeddedStore).toHaveBeenCalledWith({
      dataDir: home.dataDir,
      file: copy,
      keepSchema: true,
    });
  });

  test("says what it puts back and what is lost before it asks, and refuses where there is nothing to go back to", async () => {
    const { lib, dataDir, env, io } = await installed();
    const home = resolveHome(dataDir, env);
    const copy = String((await backup({ dataDir }, env)).data["file"]);
    await writeFile(
      home.upgradeFile,
      JSON.stringify({
        from: "0.2.0",
        to: "0.3.0+abc1234",
        at: "2026-11-26T10:00:00.000Z",
        previous: `${lib}.previous`,
        snapshot: copy,
      }),
    );
    const asked = io({ interactive: true, answer: false });

    const declined = await rollback(asked, { dataDir }, env).catch((error: unknown) => error);

    expect(declined).toMatchObject({ failure: { what: "You answered no." } });
    expect(asked.errLines.join("\n")).toContain(
      "Everything stored after that is lost from the store",
    );
    expect(await readFile(join(lib, "VERSION"), "utf8")).toContain("uketsugi 0.3.0");

    await writeFile(home.upgradeFile, "{}");
    await expect(rollback(io(), { dataDir, yes: true }, env)).rejects.toMatchObject({
      failure: { what: "There is no upgrade to go back from." },
    });
  });
});

describe("ukt restore under a service that keeps failing to start", () => {
  test("stops the unit for the work, starts it again, and says the service runs again", async () => {
    const { dataDir, machine, env, io } = await installed();
    const snapshot = String((await backup({ dataDir }, env)).data["file"]);
    await machine.onStop?.();
    machine.running = false;
    machine.gaveUp = true;
    machine.ran.length = 0;

    const restored = await restore(io(), snapshot, { dataDir, yes: true }, env);

    expect(restored.lines.at(-1)).toBe("The service is running again, on the restored store.");
    expect(machine.changes.some((line) => line.endsWith("stop uketsugi.service"))).toBe(true);
    expect(machine.running).toBe(true);
  });
});

describe("ukt doctor while the manager keeps starting a server that keeps failing", () => {
  test("gives the reason the last start failed and its way out, not a foreign answer at the port between two starts", async () => {
    const { dataDir, machine, origin, env, io } = await installed();
    await machine.onStop?.();
    machine.running = false;
    machine.gaveUp = true;
    await keepStartFailure(
      resolveHome(dataDir, env),
      "This store was made by another build.\nThe server did not start.\nNext: run the release that made it",
    );
    // Whatever answers at the port between two starts is not proof of itself.
    const between = createServer((_request, response) => response.end("starting")).listen(
      Number(new URL(origin).port),
      "127.0.0.1",
    );
    await once(between, "listening");

    const report = await doctor(io(), { dataDir }, env).finally(() => between.close());

    expect(findingsOf(report, "server")[0]).toMatchObject({
      state: "fail",
      detail: expect.stringContaining("The last start failed") as string,
      fix: "run the release that made it",
    });
  });
});
