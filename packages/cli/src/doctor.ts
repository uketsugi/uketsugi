/**
 * `ukt doctor`: what stands between an agent and its memory on this machine. It looks at the data
 * directory, the token, the service that keeps the server running, the running server, the store
 * behind it, the embedding model and the language model the server was given, and gives each
 * finding with its fix. It changes nothing.
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
import { TOKEN_ENV } from "@uketsugi/contracts";
import { CATALOG, openLocalEmbedder } from "@uketsugi/embed";
import type { JobCounts } from "@uketsugi/core";
import type { Starting } from "@uketsugi/server";
import { describeRecovery, ENGINE_DIR, usable } from "@uketsugi/store";
import { jobsFinding, plural, serverModelFindings } from "./doctor-jobs.ts";
import { checkService, foreignAnswer, listensAt } from "./doctor-service.ts";
import { connectLines } from "./harness-lines.ts";
import {
  looseModes,
  readRecord,
  readToken,
  readTokenFile,
  resolveHome,
  type Home,
} from "./home.ts";
import { hostStore, storePlace, type HostStore } from "./host-store.ts";
import { dirFlag, onStore, type OnStore, type Program } from "./program.ts";
import { CliFailure, describe, type Io, type Report } from "./report.ts";
import {
  capabilities,
  connect,
  connectAsHost,
  connectInfo,
  jobCounts,
  modelCheck,
  projects,
  servingNow,
  signInWords,
  startingAt,
} from "./server-client.ts";
import { lingers, serves, serviceState, startCommand, startFix } from "./service.ts";

/** One thing looked at. `warn` works but is less than it could be; `fail` needs its fix. */
export interface Finding {
  readonly check:
    | "data directory"
    | "token"
    | "service"
    | "server"
    | "store"
    | "model"
    | "language model"
    | "jobs"
    | "harnesses";
  readonly state: "ok" | "warn" | "fail";
  readonly detail: string;
  readonly fix?: string;
  /** What else a person may want of it, a line each: the commands that run the service. */
  readonly notes?: readonly string[];
}

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
  // The server cannot start on a store this user may not read and write, and says little of it.
  const engine = join(home.dataDir, ENGINE_DIR);
  if (!(await usable(engine)))
    return [
      {
        check,
        state: "fail",
        detail: `${engine} cannot be read and written by this user, so the server cannot open the store`,
        fix: `give this user access: chown -R $USER ${home.dataDir}`,
      },
    ];
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

/** What a check that goes through the running server says while none runs. */
function notChecked(check: Finding["check"]): Finding {
  return { check, state: "ok", detail: "not checked: it is asked of the running server" };
}

/** What the server has spent on its model in the last day, against what its operator allows. */
function spentToday(asked: { used_tokens?: number; budget_tokens?: number }): string {
  const { used_tokens: used, budget_tokens: limit } = asked;
  if (used === undefined || limit === undefined) return "";
  const full = used >= limit ? " Readings wait until it falls below that." : "";
  return `${used} of ${limit} tokens used in the last 24 hours.${full}`;
}

/**
 * The language model the running server was given: none, or whether it answers one small
 * question now. The question goes through the server, which holds the key, and costs a few tokens.
 */
async function checkLanguageModel(home: Home, configured: boolean, ask: boolean): Promise<Finding> {
  const check = "language model";
  if (!configured)
    return {
      check,
      state: "ok",
      detail: "none configured: no model reads a session, and nothing is sent to a provider",
    };
  if (!ask) return { check, state: "ok", detail: "configured; not asked (--no-llm)" };
  try {
    const asked = await modelCheck(await connectAsHost(home));
    if (asked.answers) {
      const cost = `${asked.input_tokens} tokens in, ${asked.output_tokens} out`;
      return {
        check,
        state: "ok",
        detail: `${asked.model} answers (this check took ${cost}). ${spentToday(asked)}`.trim(),
      };
    }
    return {
      check,
      state: "fail",
      detail: `${asked.model} does not answer: ${asked.detail ?? "no reason given"}`,
      fix: "give the model and its key again with `ukt setup --llm <provider/model>` (or check UKT_LLM, UKT_LLM_KEY and UKT_LLM_URL where the server starts), then start the server again",
    };
  } catch (error) {
    return failed(check, error);
  }
}

/** A server that listens and has not opened its store: it answers what it is doing, and nothing else is asked of it. */
function startingFinding(state: Starting): Finding {
  const check = "server";
  if (state.status === "starting")
    return {
      check,
      state: "warn",
      detail: "starting: it listens and has not opened its store yet",
      fix: "wait a few seconds, then run `ukt doctor` again",
    };
  return {
    check,
    state: "warn",
    detail: `recovering its store after an unclean stop: ${describeRecovery(state)}`,
    fix: "wait for it: `ukt serve` prints how far it has got, and stopping it is safe, the next start recovers again",
  };
}

/** What the running server says of itself, or null with the finding that says why it cannot be asked. */
async function checkServer(
  home: Home,
  fix: string,
  askModel: boolean,
): Promise<{
  findings: Finding[];
  vector: boolean | null;
  jobs: JobCounts | null;
  degraded: string[];
}> {
  const check = "server";
  const record = await servingNow(home).catch((error: unknown) => failed(check, error));
  if (record !== null && "check" in record)
    return { findings: [record], vector: null, jobs: null, degraded: [] };
  if (record === null) {
    const starting = await startingAt(home, await listensAt(home));
    if (starting !== null)
      return {
        findings: [startingFinding(starting), notChecked("store"), notChecked("language model")],
        vector: null,
        jobs: null,
        degraded: [],
      };
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
    // A program that holds the port is the cause, and starting the server again does not move it.
    const origin = await foreignAnswer(home);
    const stopped: Finding =
      origin === null
        ? { check, state: "fail", detail, fix }
        : {
            check,
            state: "fail",
            detail: `not running: something that is not this data directory's server answers at ${origin}, the address it listens on`,
            fix: "stop that program, or choose another port: ukt setup --port <a free port>",
          };
    return {
      findings: [stopped, store, notChecked("language model")],
      vector: null,
      jobs: null,
      degraded: [],
    };
  }
  try {
    const described = await capabilities(record);
    const about = `${described.edition}, contract ${described.contract_version}, ${plural(described.tools.length, "tool")}`;
    const serving: Finding = { check, state: "ok", detail: `answers at ${record.url} (${about})` };
    // Whatever answers at the recorded address may not be this server: it is asked nothing more unless it says it has a model.
    const runners: unknown = described.model_runners;
    const configured = Array.isArray(runners) && runners.length > 0;
    const llm = await checkLanguageModel(home, configured, askModel);
    const jobs = await connectAsHost(home).then(jobCounts, () => null);
    return {
      findings: [
        serving,
        await checkStore(home),
        llm,
        jobs === null ? notChecked("jobs") : jobsFinding(jobs),
      ],
      vector: described.features.vector,
      jobs,
      degraded: Array.isArray(described.degraded) ? described.degraded : [],
    };
  } catch (error) {
    return { findings: [failed(check, error)], vector: null, jobs: null, degraded: [] };
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
async function checkModel(
  home: Home,
  servedWithVectors: boolean | null,
  start: string,
): Promise<Finding> {
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
        fix: start === "ukt serve" ? "restart `ukt serve`" : start.replace(" start ", " restart "),
      };
    return { check, state: "ok", detail: `${verified.model}, intact and running` };
  } finally {
    await embedder.close();
  }
}

/**
 * What a harness must send to this server and what to type to connect each one, as the running
 * server says it. A harness added without a token that the server then asks one of is silent
 * about it in use, so here is where a person learns which it is.
 */
async function checkHarnesses(home: Home, dir: string): Promise<Finding[]> {
  const check = "harnesses";
  try {
    const server = await connect(home);
    const info = await connectInfo(server);
    const token = `export ${TOKEN_ENV}="$(ukt token${dir})"`;
    const [need, ...rest] = connectLines(info, token, signInWords(await capabilities(server)));
    return [{ check, state: "ok", detail: need ?? "", notes: rest }];
  } catch {
    // Why the server cannot be asked is the server's or the token's finding.
    return [];
  }
}

const MARK = { ok: "ok  ", warn: "warn", fail: "FAIL" };

function linesOf(findings: readonly Finding[]): string[] {
  return findings.flatMap((finding) => [
    `${MARK[finding.state]}  ${finding.check.padEnd(15)} ${finding.detail}`,
    ...(finding.fix === undefined ? [] : [`      fix: ${finding.fix}`]),
    ...(finding.notes ?? []).map((note) => `      ${note}`),
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
  /** False with `--no-llm`: the language model is not asked, for a check that runs on a timer. */
  readonly llm?: boolean;
  readonly json?: boolean;
}

export async function doctor(
  io: Io,
  options: DoctorOptions,
  env: NodeJS.ProcessEnv,
): Promise<Report> {
  const home = resolveHome(options.dataDir, env);
  const store = await hostStore(home, options.databaseUrl).catch((error: unknown) =>
    failed("store", error),
  );
  const service = await serviceState(io, env);
  // A server that is down is started by its service where it has one.
  const start = startCommand(service, home);
  const server = await checkServer(home, startFix(service, home), options.llm !== false);
  const about = (check: Finding["check"]): Finding[] =>
    server.findings.filter((finding) => finding.check === check);
  const findings = [
    ...(await checkDataDir(home)),
    await checkToken(home),
    await checkService(
      io,
      env,
      service,
      home,
      serves(service, home) ? await lingers(io, env) : null,
    ),
    ...about("server"),
    ...storeFindings(home, store, about("store")[0]),
    await checkModel(home, server.vector, start),
    ...serverModelFindings(start, server),
    ...about("language model"),
    ...about("jobs"),
    ...(server.vector === null ? [] : await checkHarnesses(home, dirFlag(options))),
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
    data: { data_dir: home.dataDir, findings, jobs: server.jobs },
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
export function doctorVerb({ io, env, verb, run }: Program): void {
  onStore(
    verb(
      "doctor",
      "check the data directory, the token, the service, the server, the store, the models, and say what each harness must send",
    ),
  )
    .option(
      "--no-llm",
      "do not ask the language model: asking costs a few tokens, which a check on a timer should not spend",
    )
    .action((options: DoctorOptions) => run("doctor", options, () => doctor(io, options, env)));
}
