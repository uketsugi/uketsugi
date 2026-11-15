/**
 * The language model a host was given. `ukt setup --llm provider/model` remembers it in the data
 * directory with its provider's key, in a file that is the person's alone, so that a server
 * started with nothing said, as a service is, finds it there. What a run names itself comes
 * first: `--llm` or `UKT_LLM`, with the key in `UKT_LLM_KEY`, which is how a container, which has
 * no set-up step, is given one. The key is never taken from a flag: a flag shows in the process
 * list.
 */
import {
  DEFAULT_DAILY_TOKENS,
  MODEL_PROVIDERS,
  modelName,
  type ModelConfig,
} from "@uketsugi/server";
import { MIN_DAILY_TOKENS } from "@uketsugi/core";
import { Option, type Command } from "commander";
import { readLlmRecord, removeLlmRecord, writeLlmRecord, type Home } from "./home.ts";
import { CliFailure, type Io } from "./report.ts";

/** The environment variable a provider's key is read from. */
const KEY_ENV = "UKT_LLM_KEY";
/** What `--llm` takes to say "no model": for a run, or to forget the one that is remembered. */
const NONE = "none";

export interface LlmOptions {
  /** The model as `provider/model`, or `none`: `--llm` or `UKT_LLM`. */
  readonly llm?: string;
  /** Where the model's provider is reached, for one that is not at its usual address: `--llm-url` or `UKT_LLM_URL`. */
  readonly llmUrl?: string;
  /** The most tokens the server may spend on the model in a day: `--llm-budget` or `UKT_LLM_BUDGET`. */
  readonly llmBudget?: string;
}

/**
 * Adds `--llm` and `--llm-url` to a verb. A run takes them from the environment too (`UKT_LLM`,
 * `UKT_LLM_URL`); remembering is told by the flag alone, so that a container's set-up step does
 * not write down what its environment holds for one run, to outlast it.
 */
export function llmOptions(command: Command, llm: string, from: "flag" | "environment"): Command {
  const model = new Option("--llm <provider/model>", llm);
  const url = new Option("--llm-url <url>", "where that model's provider is reached");
  const budget = new Option(
    "--llm-budget <tokens>",
    `the most tokens, in and out, the server may spend on the model in a day: readings wait once it is reached (${DEFAULT_DAILY_TOKENS} if left out, at least ${MIN_DAILY_TOKENS})`,
  );
  return from === "flag"
    ? command.addOption(model).addOption(url).addOption(budget)
    : command
        .addOption(model.env("UKT_LLM"))
        .addOption(url.env("UKT_LLM_URL"))
        .addOption(budget.env("UKT_LLM_BUDGET"));
}

function refused(what: string, next: string): CliFailure {
  return new CliFailure({ what, meaning: "Nothing was started or changed.", next });
}

/** The budget a run names, or the one on file, or none: a whole number of tokens of at least `MIN_DAILY_TOKENS`. */
function budgetOf(told: string | undefined, onFile: number | undefined): number | undefined {
  const text = told?.trim() ?? "";
  if (text === "") return onFile;
  const tokens = Number(text);
  if (Number.isInteger(tokens) && tokens >= MIN_DAILY_TOKENS) return tokens;
  throw refused(
    `"${text}" is not a budget --llm-budget takes.`,
    `Pass a whole number of tokens from ${MIN_DAILY_TOKENS} up, for the most the server may spend on the model in a day. A smaller one cannot pay for a single reading.`,
  );
}

/** A value `--llm` takes in its two parts, or a refusal when it is not `provider/model` with a provider this build knows. */
function namedModel(value: string): Pick<ModelConfig, "provider" | "model"> {
  const [first = "", ...rest] = value.split("/");
  const provider = MODEL_PROVIDERS.find((known) => known === first);
  const model = rest.join("/");
  if (provider !== undefined && model !== "") return { provider, model };
  throw refused(
    `"${value}" is not a language model --llm takes.`,
    `Pass it as provider/model, the provider one of ${MODEL_PROVIDERS.join(", ")}: for example google/gemini-3.8-flash. Pass \`${NONE}\` for no model.`,
  );
}

/** The model a record on file names, or null when the file does not read as one. */
function recorded(record: Awaited<ReturnType<typeof readLlmRecord>>): ModelConfig | null {
  if (record === null) return null;
  const [provider = "", ...rest] = record.model.split("/");
  const known = MODEL_PROVIDERS.find((name) => name === provider);
  if (known === undefined || rest.length === 0) return null;
  const at = record.url === undefined ? {} : { baseUrl: record.url };
  const budget = record.budget === undefined ? {} : { dailyTokens: record.budget };
  return { provider: known, model: rest.join("/"), apiKey: record.key, ...at, ...budget };
}

/**
 * The model a run names, made whole from what is on file where it names the same one: its
 * address, and its key when the environment holds none. A model that cannot be reached as given
 * is refused here, before anything starts.
 */
function withRemembered(
  named: Pick<ModelConfig, "provider" | "model">,
  given: { url: string; key: string },
  onFile: ModelConfig | null,
): ModelConfig {
  const same = onFile !== null && modelName(onFile) === modelName(named) ? onFile : null;
  const baseUrl = given.url === "" ? (same?.baseUrl ?? "") : given.url;
  const apiKey = given.key === "" ? (same?.apiKey ?? "") : given.key;
  // A model served on this machine often asks for no key and has no address but its own.
  const local = named.provider === "openai-compatible";
  if (local && baseUrl === "")
    throw refused(
      "--llm names an openai-compatible provider, and no address says where it is.",
      "Pass its base URL as --llm-url or UKT_LLM_URL, for example http://127.0.0.1:11434/v1.",
    );
  if (!local && apiKey === "")
    throw refused(
      `--llm names a model at ${named.provider}, and no key for it was given.`,
      `Run \`ukt setup --llm ${modelName(named).replace(" · ", "/")}\` to give the key once, or set ${KEY_ENV} in the environment this starts in.`,
    );
  return { ...named, apiKey, ...(baseUrl === "" ? {} : { baseUrl }) };
}

/**
 * The language model a server on this data directory runs with: the one this run names, else the
 * one `ukt setup` remembered, else none, and then the server asks no model anything.
 */
export async function hostModel(
  home: Home,
  options: LlmOptions,
  env: NodeJS.ProcessEnv,
): Promise<ModelConfig | null> {
  const value = options.llm?.trim() ?? "";
  if (value === NONE) return null;
  const onFile = recorded(await readLlmRecord(home));
  const given = { url: options.llmUrl?.trim() ?? "", key: env[KEY_ENV] ?? "" };
  const model = value === "" ? onFile : withRemembered(namedModel(value), given, onFile);
  if (model === null) return null;
  const dailyTokens = budgetOf(options.llmBudget, model.dailyTokens);
  return dailyTokens === undefined ? model : { ...model, dailyTokens };
}

/**
 * The key `ukt setup` was given for a model: the one in the environment, else one the person
 * types at the terminal, where it is not shown. None where neither is there, or the model is one
 * that asks for none.
 */
async function givenKey(
  io: Io,
  named: Pick<ModelConfig, "provider" | "model">,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const held = env[KEY_ENV];
  if (held !== undefined) return held;
  if (!io.interactive || named.provider === "openai-compatible") return "";
  return (await io.secret(`The key for ${modelName(named)}`)) ?? "";
}

/** Remembers a model with its key and its budget, and says so. */
async function remember(home: Home, model: ModelConfig, told?: string): Promise<string> {
  const { apiKey, baseUrl, dailyTokens: was, ...rest } = model;
  const budget = budgetOf(told, was);
  const at = baseUrl === undefined ? {} : { url: baseUrl };
  const limit = budget === undefined ? {} : { budget };
  await writeLlmRecord(home, {
    model: `${rest.provider}/${rest.model}`,
    key: apiKey,
    ...at,
    ...limit,
  });
  const how = apiKey === "" ? "remembered" : "remembered with its key";
  return `${modelName(rest)}, ${how} in ${home.llmFile}, ${budget ?? DEFAULT_DAILY_TOKENS} tokens a day at most`;
}

/** Told no model: a budget alone changes the one remembered, key and all, and asks for nothing. */
async function budgetAlone(
  home: Home,
  onFile: ModelConfig | null,
  told: string | undefined,
): Promise<string | null> {
  if ((told ?? "") === "")
    return onFile === null ? null : `${modelName(onFile)}, remembered in ${home.llmFile}`;
  if (onFile === null)
    throw refused(
      "--llm-budget was given and no language model is remembered to have one.",
      "Name the model too: ukt setup --llm <provider/model> --llm-budget <tokens>.",
    );
  return remember(home, onFile, told);
}

/**
 * What `ukt setup` does about the language model, and the line it reports, if any. Told a model,
 * it remembers it with its key and budget. Told `none`, it forgets. Told nothing, it leaves what
 * is remembered as it is.
 */
export async function rememberModel(
  io: Io,
  home: Home,
  options: LlmOptions,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const value = options.llm?.trim() ?? "";
  const onFile = recorded(await readLlmRecord(home));
  if (value === NONE) {
    await removeLlmRecord(home);
    return onFile === null ? null : `none: ${modelName(onFile)} is forgotten`;
  }
  if (value === "") return budgetAlone(home, onFile, options.llmBudget);
  const named = namedModel(value);
  const given = { url: options.llmUrl?.trim() ?? "", key: await givenKey(io, named, env) };
  return remember(home, withRemembered(named, given, onFile), options.llmBudget);
}

/**
 * What is sent to a model's provider, for a person to read before they turn it on and each time
 * the server starts with one. It is the whole of what leaves, so a change to what the server sends
 * is a change here.
 */
export function sentLine(name: string): string {
  return `${name} is sent what your sessions' agents said once a session is over (the closing note; with the plugin's capture option, every turn's request and answer), the claims of the facts you published in it and of your own facts near what it reads, and up to 60 more of your claims in the project, private ones included. Known kinds of secret are removed first; a password with no known form is not.`;
}

/** What `ukt setup` is about to do about the language model: nothing, or remember or forget one. */
export async function llmChange(
  home: Home,
  options: LlmOptions,
): Promise<{
  named: Pick<ModelConfig, "provider" | "model"> | null;
  onFile: ModelConfig | null;
  pending: boolean;
}> {
  const value = options.llm?.trim() ?? "";
  const onFile = recorded(await readLlmRecord(home));
  if (value === "") return { named: null, onFile, pending: (options.llmBudget ?? "") !== "" };
  if (value === NONE) return { named: null, onFile, pending: onFile !== null };
  return { named: namedModel(value), onFile, pending: true };
}
