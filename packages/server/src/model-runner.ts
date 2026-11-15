/**
 * The language model a server's operator configured, behind core's `ModelRunner`: one provider,
 * one key, one model. The Vercel AI SDK speaks each provider's own API, so the same chore goes to
 * Google, OpenAI, Anthropic, or anything that serves OpenAI's chat API at a URL (a local model
 * among them).
 *
 * Nothing here is reached unless the operator named a model: a server with none makes no runner,
 * and the SDK itself is loaded only when one is made, so no other `ukt` verb pays for it. The key
 * is always the one given: a key that happens to be in the environment under a provider's usual
 * name is never picked up. A chore's material is sent as the user's message and its instructions
 * as the system's, and the answer comes back as JSON, which core checks.
 */
import { ModelError, type Caller, type Chore, type ModelRunner } from "@uketsugi/core";
import type * as AiSdk from "ai";

/** The providers a model can be configured on. The last is any server that speaks OpenAI's chat API, at a URL. */
export const MODEL_PROVIDERS = ["google", "openai", "anthropic", "openai-compatible"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface ModelConfig {
  readonly provider: ModelProvider;
  /** The model's id as its provider names it. */
  readonly model: string;
  /** The provider's key. A local server that asks for none takes an empty one. */
  readonly apiKey: string;
  /** Where the provider is reached. Needed for `openai-compatible`; the others have their own. */
  readonly baseUrl?: string;
  /** The most tokens the server may spend on it in a day. Left out, `DEFAULT_DAILY_TOKENS`. */
  readonly dailyTokens?: number;
}

/**
 * What a server may spend on its model in a day unless its operator says otherwise: about a
 * hundred full-size readings at most, which at today's prices for a small model is a few dollars.
 */
export const DEFAULT_DAILY_TOKENS = 1_000_000;

/** How much of a provider's own words about a failure a message keeps. */
const REASON_CHARS = 240;
/**
 * How much a model that can think before it answers is asked to: the least its provider allows.
 * Reading a record and comparing statements need no long deliberation, and a model's thinking is
 * billed as output.
 */
const REASONING = "none";

/** The configured model, from its provider's own package, which is loaded here and not before. */
async function languageModel(config: ModelConfig): Promise<AiSdk.LanguageModel> {
  const { provider, model, apiKey, baseUrl } = config;
  const at = baseUrl === undefined ? {} : { baseURL: baseUrl };
  switch (provider) {
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      return createGoogleGenerativeAI({ apiKey, ...at })(model);
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey, ...at })(model);
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ apiKey, ...at })(model);
    }
    case "openai-compatible": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      return createOpenAICompatible({ name: provider, apiKey, baseURL: baseUrl ?? "" })(model);
    }
  }
}

/** The shortest piece of a key that is taken out of a text on its own: a provider that masks a key shows its two ends. */
const KEY_END_CHARS = 8;

/**
 * The text without the key: the whole of it, and any beginning or ending of it that is long
 * enough to be told from other words. A provider may repeat the key it refused, whole or masked,
 * in the reason it gives, and that text goes to logs, `ukt doctor` and the API.
 */
export function withoutKey(text: string, key: string): string {
  let kept = text;
  for (let size = key.length; size >= KEY_END_CHARS; size -= 1) {
    for (const piece of new Set([key.slice(0, size), key.slice(-size)])) {
      kept = kept.replaceAll(piece, "[key]");
    }
  }
  return kept;
}

/**
 * A failed call as core is told of it: the status and the provider's own reason, cut short and
 * without the key, and whether asking again may help. The SDK's error is not passed on: it holds
 * the request, which is a session's text, and a log must never get that.
 */
function failureOf(sdk: typeof AiSdk, error: unknown, key: string): ModelError {
  if (sdk.APICallError.isInstance(error)) {
    const status = error.statusCode === undefined ? "no answer" : `status ${error.statusCode}`;
    // The key comes out before the cut: a cut could leave half of it, which no rule would know.
    const reason = withoutKey(error.message, key).replace(/\s+/g, " ").slice(0, REASON_CHARS);
    return new ModelError(
      `the provider refused the call (${status}): ${reason}`,
      error.isRetryable,
    );
  }
  const name = error instanceof Error ? error.name : "unknown error";
  // Time ran out, or the server is stopping: the same chore may be answered later.
  if (name === "AbortError" || name === "TimeoutError") {
    return new ModelError("the model did not answer in time", true);
  }
  // An answer that is not the JSON asked for would be given again.
  return new ModelError(`the model's answer could not be read (${name})`, false);
}

/** A configured model as a person reads it: its provider and its name there. */
export function modelName(config: Pick<ModelConfig, "provider" | "model">): string {
  return `${config.provider} · ${config.model}`;
}

/**
 * The runner for a configured model. It serves the one person who configured it, `agreedBy`:
 * theirs is the only text it is ever sent. It makes no request until a chore is run.
 */
export async function createModelRunner(
  config: ModelConfig,
  agreedBy: Pick<Caller, "orgId" | "principalId">,
): Promise<ModelRunner> {
  const sdk = await import("ai");
  // The SDK's notes on how it fitted a setting to a model go to standard error unless told not
  // to: they are not this server's to print, and what fails is reported as a `ModelError`.
  globalThis.AI_SDK_LOG_WARNINGS = false;
  const model = await languageModel(config);
  return {
    kind: "endpoint",
    name: modelName(config),
    dailyTokens: config.dailyTokens ?? DEFAULT_DAILY_TOKENS,
    serves: (person) =>
      person.orgId === agreedBy.orgId && person.principalId === agreedBy.principalId,
    async run(chore: Chore, signal?: AbortSignal) {
      try {
        const answer = await sdk.generateText({
          model,
          instructions: chore.instructions,
          prompt: chore.material,
          output: sdk.Output.object({ schema: sdk.jsonSchema(chore.shape) }),
          temperature: 0,
          // A server that only speaks OpenAI's chat API may not know the setting.
          ...(config.provider === "openai-compatible" ? {} : { reasoning: REASONING }),
          abortSignal: signal,
        });
        return {
          output: answer.output,
          inputTokens: answer.usage.inputTokens ?? 0,
          outputTokens: answer.usage.outputTokens ?? 0,
        };
      } catch (error) {
        throw failureOf(sdk, error, config.apiKey);
      }
    },
  };
}
