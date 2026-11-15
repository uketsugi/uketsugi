import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG } from "@uketsugi/embed";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { doctor, type Finding } from "../src/doctor.ts";
import { token } from "../src/host-verbs.ts";
import { main } from "../src/index.ts";
import { exportFacts, ui } from "../src/remote-verbs.ts";
import { CliFailure, confirmPlan, progressLine, runVerb, type Report } from "../src/report.ts";
import { nextCommands, setup } from "../src/setup.ts";
import { backup, restore } from "../src/store-verbs.ts";
import { fakeIo, tempDir } from "./support.ts";

const LISTEN = { host: "127.0.0.1", port: "7410" };
const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe("what a verb prints", () => {
  const report = { data: { n: 1 }, lines: ["one", "two"] };
  const failure = { what: "It broke.", meaning: "Nothing was done.", next: "Try again." };

  test("is its lines, or with --json one envelope on one line", async () => {
    const text = fakeIo();
    const json = fakeIo();

    expect(await runVerb(text, "doctor", false, () => Promise.resolve(report))).toBe(0);
    expect(await runVerb(json, "doctor", true, () => Promise.resolve(report))).toBe(0);

    expect(text.outLines).toEqual(["one", "two"]);
    expect(json.outLines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { ok: true, command: "doctor", data: { n: 1 } },
    ]);
  });

  test("on a failure says what happened, what it means and what to do next, and exits 1", async () => {
    const text = fakeIo();
    const json = fakeIo();
    const fails = () => Promise.reject(new CliFailure(failure));

    expect(await runVerb(text, "backup", false, fails)).toBe(1);
    expect(await runVerb(json, "backup", true, fails)).toBe(1);

    expect(text.errLines).toEqual(["It broke.", "Nothing was done.", "Next: Try again."]);
    expect(JSON.parse(json.outLines[0] ?? "")).toEqual({
      ok: false,
      command: "backup",
      error: failure,
    });
  });

  test("gives an error nobody expected the same three parts", async () => {
    const io = fakeIo();

    await runVerb(io, "serve", true, () => Promise.reject(new Error("disk full")));

    expect(JSON.parse(io.outLines[0] ?? "")).toMatchObject({
      ok: false,
      error: { what: "disk full", next: expect.stringContaining("ukt doctor") as string },
    });
  });
});

describe("a destructive verb", () => {
  const plan = ["This replaces the store."];

  test("shows its plan and is refused where nobody can be asked", async () => {
    const io = fakeIo({ interactive: false });

    const refused = await confirmPlan(io, plan, {}).catch((error: unknown) => error);

    expect(io.errLines).toEqual(plan);
    expect(refused).toMatchObject({
      failure: {
        meaning: "Nothing was changed.",
        next: expect.stringContaining("--yes") as string,
      },
      data: { plan },
    });
  });

  test("asks at a terminal, stops on no, and does not ask with --yes", async () => {
    const no = fakeIo({ interactive: true, answer: false });
    const yes = fakeIo({ interactive: true, answer: true });
    const unasked = fakeIo({ interactive: false });

    await expect(confirmPlan(no, plan, {})).rejects.toMatchObject({
      failure: { what: "You answered no." },
    });
    await confirmPlan(yes, plan, {});
    await confirmPlan(unasked, plan, { yes: true });

    expect(yes.questions).toEqual(["Go ahead?"]);
    expect(unasked.questions).toEqual([]);
  });

  test("restore names the snapshot it lacks before it asks anything", async () => {
    const io = fakeIo({ interactive: true });
    const dataDir = await tempDir();

    const refused = restore(io, join(dataDir, "none.tgz"), { dataDir }, {});

    await expect(refused).rejects.toMatchObject({
      failure: { what: `There is no snapshot file at ${join(dataDir, "none.tgz")}.` },
    });
    expect(io.questions).toEqual([]);
  });

  test("restore shows what it will replace and changes nothing without a yes", async () => {
    const io = fakeIo({ interactive: false });
    const dataDir = await tempDir();
    // The engine's directory is what says a data directory holds a store.
    await mkdir(join(dataDir, "pg"));
    const snapshot = join(dataDir, "snapshot.tgz");
    await writeFile(snapshot, "not opened before the answer");

    await expect(restore(io, snapshot, { dataDir }, {})).rejects.toBeInstanceOf(CliFailure);

    expect(io.errLines.join("\n")).toContain(`This replaces the whole store in ${dataDir}`);
    expect(io.errLines.join("\n")).toContain("is first saved to");
    // A snapshot holds people, tokens and choices as they were: the plan says what that undoes.
    expect(io.errLines.join("\n")).toContain("a token revoked since works again");
    expect(await readFile(snapshot, "utf8")).toBe("not opened before the answer");
  });
});

describe("the line a download's progress is drawn on", () => {
  // What `ukt setup` downloads, by the names it reports: the runtime's tarballs and the model's files.
  const names = [
    ...CATALOG.runtime.map((artifact) => `${artifact.name}@${artifact.version}`),
    ...CATALOG.files.map((file) => file.path),
  ];
  const sizes: [number, number | null][] = [
    [0, null],
    [999, 1526],
    [51_885_568, 51_885_568],
    [118_400_000, 118_400_000],
    [999_400_000, 999_400_000],
  ];

  test("fits on one line of the spinner at every width from 60 columns up, whole", () => {
    for (let columns = 60; columns <= 240; columns += 1) {
      for (const name of names) {
        for (const [done, total] of sizes) {
          const line = progressLine(name, done, total, columns);
          // The spinner's mark and two spaces before it, its three dots after, one column free.
          expect(line.length + 7, `${columns} columns: ${line}`).toBeLessThanOrEqual(columns);
          if (total !== 999_400_000) expect(line.endsWith(name), line).toBe(true);
        }
      }
    }
    expect(progressLine("onnxruntime-node@1.30.0", 63_000_000, 118_400_000, 60)).toBe(
      "63 MB of 118 MB · onnxruntime-node@1.30.0",
    );
  });

  test("is cut to fit a narrower terminal, and the sizes are the last to go", () => {
    const line = progressLine("onnx/model_quantized.onnx_data", 51_000_000, 51_885_568, 40);
    expect(line).toBe("51 MB of 52 MB · onnx/model_quan…");
    expect(line.length + 7).toBe(40);
    expect(progressLine("a-file", 1000, null, 4)).toBe("…");
  });
});

describe("ukt setup and ukt token", () => {
  let dataDir: string;
  let first: Report;

  // Setup issues the first token through the store, which it creates: engine work, so a hook.
  beforeAll(async () => {
    dataDir = join(await mkdtemp(join(tmpdir(), "ukt-setup-")), "data");
    first = await setup(fakeIo(), { dataDir, ...LISTEN, model: false }, {});
  });
  afterAll(() => rm(join(dataDir, ".."), { recursive: true, force: true }));

  test("setup makes a private data directory and token once, and says what to do next", async () => {
    const held = await readFile(join(dataDir, "token"), "utf8");

    const second = await setup(fakeIo(), { dataDir, ...LISTEN, model: false }, {});

    expect(first.data).toMatchObject({
      created: { data_dir: true, token: true },
      model: { state: "skipped" },
      mcp_url: "http://127.0.0.1:7410/mcp",
    });
    expect(second.data).toMatchObject({ created: { data_dir: false, token: false } });
    expect(held).toMatch(/^ukt_[0-9a-f]{48}\n$/);
    expect(await readFile(join(dataDir, "token"), "utf8")).toBe(held);
    expect(await modeOf(dataDir)).toBe(0o700);
    expect(await modeOf(join(dataDir, "token"))).toBe(0o600);
    // Nothing runs the server, so the next step is to start it; what to type for a harness comes once it runs.
    expect(
      first.lines.slice(first.lines.indexOf(`Start the server:  ukt serve --data-dir ${dataDir}`)),
    ).toEqual([
      `Start the server:  ukt serve --data-dir ${dataDir}`,
      "",
      `Once it runs, \`ukt doctor --data-dir ${dataDir}\` prints what to type for each harness.`,
      "",
      "An agent names its project by the repository's origin remote. For work in a directory",
      "without one, make a project name on the dashboard's Projects page.",
    ]);
  });

  test("setup's next steps repeat the one thing the next commands must be told again: the data directory", () => {
    const typed = 'export UKT_TOKEN="$(ukt token)"';
    expect(nextCommands({})).toEqual({ serve: "ukt serve", token: typed, ui: "ukt ui" });
    // A word a shell would split is quoted, so the line can be typed as it stands.
    expect(nextCommands({ dataDir: "/srv/my data" })).toEqual({
      serve: "ukt serve --data-dir '/srv/my data'",
      token: `export UKT_TOKEN="$(ukt token --data-dir '/srv/my data')"`,
      ui: "ukt ui --data-dir '/srv/my data'",
    });
  });

  test("setup prints a URL that can be opened, whatever address the server will bind", async () => {
    const urlFor = async (host: string, port: string) =>
      (await setup(fakeIo(), { dataDir, host, port, model: false }, {})).data["mcp_url"];

    expect(await urlFor("0.0.0.0", "8000")).toBe("http://127.0.0.1:8000/mcp");
    expect(await urlFor("::1", "7410")).toBe("http://[::1]:7410/mcp");
    await expect(urlFor("127.0.0.1", "http")).rejects.toMatchObject({
      failure: { what: '"http" is not a value --port takes.' },
    });
  });

  test("setup refuses a UKT_MODEL_DIR that holds no model, and says the rest is ready", async () => {
    const env = { UKT_MODEL_DIR: join(dataDir, "no-model-here") };

    const refused = await setup(fakeIo(), { dataDir, ...LISTEN, model: true }, env);

    expect(refused.failure).toMatchObject({
      what: expect.stringContaining(`UKT_MODEL_DIR=${env.UKT_MODEL_DIR} cannot be used`) as string,
      meaning: expect.stringContaining("`ukt serve` will run") as string,
    });
    expect(refused.data).toMatchObject({ model: { state: "failed" } });
  });

  test("token prints the data directory's token alone, else UKT_TOKEN, else how to get one", async () => {
    const empty = await tempDir();
    const held = (await readFile(join(dataDir, "token"), "utf8")).trim();

    const none = await token(fakeIo(), { dataDir: empty }, {}).catch((error: unknown) => error);

    expect(none).toMatchObject({ failure: { next: "Run `ukt setup`." } });
    expect((await token(fakeIo(), { dataDir }, { UKT_TOKEN: "given" })).lines).toEqual([held]);
    expect((await token(fakeIo(), { dataDir: empty }, { UKT_TOKEN: "given" })).lines).toEqual([
      "given",
    ]);
  });
});

describe("the store a data directory names", () => {
  const elsewhere = "postgres://ukt:s3cr3t-pass@db.internal:5432/memory";

  test("a host whose store is in its data directory refuses a database: it would start a second, empty store", async () => {
    const dataDir = await tempDir();
    await mkdir(join(dataDir, "pg"));
    const told = { dataDir, databaseUrl: elsewhere, ...LISTEN, model: false };

    const refused = await setup(fakeIo(), told, {}).catch((error: unknown) => error);

    expect(refused).toMatchObject({
      failure: {
        what: `The data directory ${dataDir} holds this host's store, and the address given names another: the PostgreSQL database db.internal:5432/memory.`,
        next: expect.stringContaining("--data-dir") as string,
      },
    });
    expect(JSON.stringify(refused)).not.toContain("s3cr3t-pass");
    await expect(backup(told, {})).rejects.toMatchObject({
      failure: { what: expect.stringContaining("holds this host's store") as string },
    });
  });

  test("an address that is no PostgreSQL URL is refused and never repeated", async () => {
    const dataDir = await tempDir();
    const told = { dataDir, databaseUrl: "db.internal/memory?password=s3cr3t-pass" };

    const refused = await token(fakeIo(), { ...told, rotate: true, yes: true }, {}).catch(
      (error: unknown) => error,
    );

    expect(refused).toMatchObject({
      failure: { next: "Pass it as postgres://user:password@host:port/database." },
    });
    expect(JSON.stringify(refused)).not.toContain("s3cr3t-pass");
  });

  test("a verb that works on a store makes none where there is none", async () => {
    const dataDir = join(await tempDir(), "mistyped");
    const none = { failure: { what: `The data directory ${dataDir} holds no store yet.` } };

    await expect(token(fakeIo(), { dataDir, rotate: true, yes: true }, {})).rejects.toMatchObject(
      none,
    );
    await expect(backup({ dataDir }, {})).rejects.toMatchObject(none);
    await expect(stat(dataDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("ukt doctor with no server running", () => {
  const findingsOf = (data: Readonly<Record<string, unknown>>) => data["findings"] as Finding[];

  test("gives each fault its fix and fails", async () => {
    const dataDir = join(await tempDir(), "absent");

    const report = await doctor(fakeIo(), { dataDir }, {});

    expect(findingsOf(report.data)).toEqual([
      {
        check: "data directory",
        state: "fail",
        detail: `${dataDir} does not exist`,
        fix: "ukt setup",
      },
      { check: "token", state: "fail", detail: expect.any(String) as string, fix: "ukt setup" },
      {
        check: "service",
        state: "ok",
        // The verb was handed an environment with no home in it, as this test's is.
        detail:
          "none: this account has no home directory, so the server runs while `ukt serve` does",
      },
      { check: "server", state: "fail", detail: "not running", fix: "ukt serve" },
      { check: "store", state: "ok", detail: expect.stringContaining("not checked") as string },
      { check: "model", state: "warn", detail: expect.any(String) as string, fix: "ukt setup" },
    ]);
    expect(report.failure).toMatchObject({
      what: "3 of 6 checks failed.",
      meaning: "Until they are fixed, an agent may not reach its memory on this machine.",
    });
    expect(report.lines).toContain("FAIL  server          not running");
    expect(report.lines).toContain("      fix: ukt serve");
  });

  test("names a data directory or token that other accounts can read, with the chmod that closes it", async () => {
    const dataDir = join(await tempDir(), "data");
    await mkdir(dataDir, { mode: 0o755 });
    await writeFile(join(dataDir, "token"), "ukt_held\n", { mode: 0o644 });

    const findings = findingsOf((await doctor(fakeIo(), { dataDir }, {})).data);

    expect(findings.filter((finding) => finding.check === "data directory")).toEqual([
      expect.objectContaining({ state: "fail", fix: `chmod 700 ${dataDir}` }),
      expect.objectContaining({ state: "fail", fix: `chmod 600 ${join(dataDir, "token")}` }),
    ]);
    expect(findings.find((finding) => finding.check === "token")).toMatchObject({ state: "ok" });
  });

  test("says a server that left its record no longer answers", async () => {
    const dataDir = await tempDir();
    await writeFile(join(dataDir, "server.json"), JSON.stringify({ url: "http://127.0.0.1:1" }));

    const findings = findingsOf((await doctor(fakeIo(), { dataDir }, {})).data);

    expect(findings.find((finding) => finding.check === "server")).toEqual({
      check: "server",
      state: "fail",
      detail: "not running: a server left its record and no longer answers at http://127.0.0.1:1",
      fix: "ukt serve",
    });
  });
});

describe("the verbs that ask the server, with none running", () => {
  test("ui and export say so and how to start one", async () => {
    const dataDir = await tempDir();
    const expected = {
      failure: {
        what: `No server is running on the data directory ${dataDir}.`,
        next: expect.stringContaining("ukt serve") as string,
      },
    };

    await expect(ui(fakeIo(), { dataDir, open: true }, {})).rejects.toMatchObject(expected);
    await expect(exportFacts({ dataDir, markdown: dataDir }, {})).rejects.toMatchObject(expected);
  });
});

describe("the ukt program", () => {
  test("parses a verb's options, prints its envelope and returns its exit code", async () => {
    const dataDir = await tempDir();
    await writeFile(join(dataDir, "token"), "ukt_held\n", { mode: 0o600 });
    const io = fakeIo();

    const printed = await main(["token", "--data-dir", dataDir, "--json"], io, {});
    const missing = await main(["export", "--data-dir", dataDir], io, {});
    const unknown = await main(["frobnicate"], io, {});

    expect(printed).toBe(0);
    expect(JSON.parse(io.outLines[0] ?? "")).toEqual({
      ok: true,
      command: "token",
      data: { token: "ukt_held" },
    });
    expect(missing).toBe(1);
    expect(io.errLines.join("\n")).toContain("--markdown <folder>");
    expect(unknown).toBe(1);
  });
});
