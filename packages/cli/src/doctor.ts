/**
 * `ukt doctor`: what stands between an agent and its memory on this machine. It looks at the data
 * directory, the token, the running server, the store behind it and the embedding model, and
 * gives each finding with its fix. It changes nothing.
 */
import { access } from "node:fs/promises";
import { TOKEN_ENV } from "@uketsugi/contracts";
import { CATALOG, openLocalEmbedder } from "@uketsugi/embed";
import {
  looseModes,
  readRecord,
  readToken,
  readTokenFile,
  resolveHome,
  type Home,
} from "./home.ts";
import { hostStore, storePlace, type HostStore } from "./host-store.ts";
import { onStore, type OnStore, type Program } from "./program.ts";
import { CliFailure, describe, type Report } from "./report.ts";
import { capabilities, connect, projects, servingNow } from "./server-client.ts";

/** One thing looked at. `warn` works but is less than it could be; `fail` needs its fix. */
export interface Finding {
  readonly check: "data directory" | "token" | "server" | "store" | "model";
  readonly state: "ok" | "warn" | "fail";
  readonly detail: string;
  readonly fix?: string;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** A failed request as a finding: the failure's own words and its next step. */
function failed(check: Finding["check"], error: unknown): Finding {
  if (error instanceof CliFailure)
    return { check, state: "fail", detail: error.failure.what, fix: error.failure.next };
  return { check, state: "fail", detail: describe(error) };
}

async function checkDataDir(home: Home): Promise<Finding[]> {
  const check = "data directory";
  const there = await access(home.dataDir).then(
    () => true,
    () => false,
  );
  if (!there)
    return [{ check, state: "fail", detail: `${home.dataDir} does not exist`, fix: "ukt setup" }];
  const loose = await looseModes(home);
  if (loose.length === 0) return [{ check, state: "ok", detail: home.dataDir }];
  return loose.map(({ path, mode, allowed }) => ({
    check,
    state: "fail",
    detail: `${path} has mode ${mode}: other accounts on this machine can read it`,
    fix: `chmod ${allowed} ${path}`,
  }));
}

async function checkToken(home: Home): Promise<Finding> {
  const check = "token";
  if ((await readTokenFile(home)) !== null) return { check, state: "ok", detail: home.tokenFile };
  if (home.givenToken !== undefined)
    return { check, state: "ok", detail: `taken from ${TOKEN_ENV}` };
  return { check, state: "fail", detail: `there is none in ${home.tokenFile}`, fix: "ukt setup" };
}

/** What the running server says of itself, or null with the finding that says why it cannot be asked. */
async function checkServer(home: Home): Promise<{ findings: Finding[]; vector: boolean | null }> {
  const check = "server";
  const record = await servingNow(home);
  if (record === null) {
    const left = await readRecord(home);
    const detail =
      left === null
        ? "not running"
        : `not running: a server left its record and no longer answers at ${left.url}`;
    const store: Finding = {
      check: "store",
      state: "ok",
      detail: "not checked: the store is checked through the running server",
    };
    return { findings: [{ check, state: "fail", detail, fix: "ukt serve" }, store], vector: null };
  }
  try {
    const described = await capabilities(record);
    const about = `${described.edition}, contract ${described.contract_version}, ${plural(described.tools.length, "tool")}`;
    const serving: Finding = { check, state: "ok", detail: `answers at ${record.url} (${about})` };
    return {
      findings: [serving, await checkStore(home)],
      vector: described.features.vector,
    };
  } catch (error) {
    return { findings: [failed(check, error)], vector: null };
  }
}

/** The store, asked through the server with the token: an answer proves both. */
async function checkStore(home: Home): Promise<Finding> {
  const check = "store";
  if ((await readToken(home)) === null)
    return {
      check,
      state: "fail",
      detail: "not checked: there is no token to ask with",
      fix: "ukt setup",
    };
  try {
    // The token goes only to a server that has proven it is this data directory's.
    const list = await projects(await connect(home));
    const facts = list.projects.reduce((sum, project) => sum + project.facts, 0);
    const held = `${plural(list.projects.length, "project")}, ${plural(facts, "fact")}`;
    return { check, state: "ok", detail: `answers and accepts the token: ${held}` };
  } catch (error) {
    return failed(check, error);
  }
}

/** The model: its files against their pins, read once, then one text through it. */
async function checkModel(home: Home, servedWithVectors: boolean | null): Promise<Finding> {
  const check = "model";
  const embedder = openLocalEmbedder(home.modelDir);
  try {
    const verified = await embedder.check();
    if (!verified.ok) {
      const what = verified.reason === "not_installed" ? "not installed" : "not usable";
      const detail = `${what} (${verified.detail}); search matches words only`;
      if (verified.reason === "unsupported_platform") return { check, state: "warn", detail };
      const fix = home.modelIsOurs
        ? "ukt setup"
        : "repair the directory UKT_MODEL_DIR names, or unset it and run `ukt setup`";
      return { check, state: verified.reason === "changed" ? "fail" : "warn", detail, fix };
    }
    const ran = await embedder.embed(["does the model run?"], "query").then(
      ([vector]) => (vector?.length === CATALOG.dims ? null : "it returned no vector"),
      (error: unknown) => describe(error),
    );
    if (ran !== null)
      return {
        check,
        state: "fail",
        detail: `${verified.model} is intact but does not run: ${ran}; search matches words only`,
        fix: "report this with the output of `ukt doctor --json`",
      };
    if (servedWithVectors === false)
      return {
        check,
        state: "warn",
        detail: `${verified.model} is installed, but the running server started without it`,
        fix: "restart `ukt serve`",
      };
    return { check, state: "ok", detail: `${verified.model}, intact and running` };
  } finally {
    await embedder.close();
  }
}

const MARK = { ok: "ok  ", warn: "warn", fail: "FAIL" };

function linesOf(findings: readonly Finding[]): string[] {
  return findings.flatMap((finding) => [
    `${MARK[finding.state]}  ${finding.check.padEnd(15)} ${finding.detail}`,
    ...(finding.fix === undefined ? [] : [`      fix: ${finding.fix}`]),
  ]);
}

/**
 * The store's finding with where the store is, for a host that keeps it on a PostgreSQL server. A
 * host that is told of a second store fails here, whatever its server answers.
 */
function storeFindings(
  home: Home,
  store: HostStore | Finding,
  asked: Finding | undefined,
): Finding[] {
  if ("check" in store) return [store];
  if (asked === undefined) return [];
  if (store.kind === "embedded") return [asked];
  return [{ ...asked, detail: `${asked.detail} · ${storePlace(home, store)}` }];
}

export interface DoctorOptions extends OnStore {
  readonly dataDir?: string;
  readonly json?: boolean;
}

export async function doctor(options: DoctorOptions, env: NodeJS.ProcessEnv): Promise<Report> {
  const home = resolveHome(options.dataDir, env);
  const store = await hostStore(home, options.databaseUrl).catch((error: unknown) =>
    failed("store", error),
  );
  const server = await checkServer(home);
  const isStore = (finding: Finding): boolean => finding.check === "store";
  const findings = [
    ...(await checkDataDir(home)),
    await checkToken(home),
    ...server.findings.filter((finding) => !isStore(finding)),
    ...storeFindings(home, store, server.findings.find(isStore)),
    await checkModel(home, server.vector),
  ];
  const count = (state: Finding["state"]): number =>
    findings.filter((finding) => finding.state === state).length;
  const [failures, warnings] = [count("fail"), count("warn")];
  const summary =
    failures + warnings === 0
      ? "Everything is in order."
      : `${failures} failed, ${warnings} to look at, ${count("ok")} in order.`;
  // An agent's way to its memory runs through the token, the server and the store. A failure
  // elsewhere (a data directory others can read, a model that does not run) leaves that way open.
  const cut = findings.some(
    ({ state, check }) => state === "fail" && ["token", "server", "store"].includes(check),
  );
  return {
    data: { data_dir: home.dataDir, findings },
    lines: [...linesOf(findings), summary],
    ...(failures === 0
      ? {}
      : {
          failure: {
            what: `${failures} of ${findings.length} checks failed.`,
            meaning: cut
              ? "Until they are fixed, an agent may not reach its memory on this machine."
              : "Agents reach their memory all the same: what failed is how it is kept on this machine.",
            next: "Apply each fix above, then run `ukt doctor` again.",
          },
        }),
  };
}

/** Adds `doctor` to the program. */
export function doctorVerb({ env, verb, run }: Program): void {
  onStore(
    verb("doctor", "check the data directory, the token, the server, the store and the model"),
  ).action((options: DoctorOptions) => run("doctor", options, () => doctor(options, env)));
}
