/**
 * Whether the language model a server was given answers: one small question, asked now. It is
 * what `ukt doctor` reports, since a key, a model's name and a provider's address can each be
 * wrong and nothing else says so until a session ends. A server with no model asks nothing.
 */
import type { ModelCheck } from "@uketsugi/contracts";
import { BUDGET_WINDOW_MS } from "../digest/budget.ts";
import type { Chore, CorePorts } from "../ports.ts";

/** How long the model may take over the question. */
const ANSWER_WITHIN_MS = 30_000;

const QUESTION: Chore = {
  step: "check",
  instructions: 'This is a connection check. Answer with JSON only, exactly: {"ok":true}',
  material: "{}",
  shape: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
};

export async function checkModel(
  ports: Pick<CorePorts, "runner" | "clock" | "store">,
): Promise<ModelCheck> {
  const { runner } = ports;
  if (runner === undefined) {
    return { model: null, answers: false, input_tokens: 0, output_tokens: 0 };
  }
  const budget = {
    used_tokens: await ports.store.sessions.spentSince(
      new Date(ports.clock.now().getTime() - BUDGET_WINDOW_MS),
    ),
    budget_tokens: runner.dailyTokens,
  };
  try {
    const answer = await runner.run(QUESTION, ports.clock.timeout(ANSWER_WITHIN_MS));
    const { inputTokens: input_tokens, outputTokens: output_tokens } = answer;
    return { model: runner.name, answers: true, input_tokens, output_tokens, ...budget };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "the call failed";
    return {
      model: runner.name,
      answers: false,
      detail,
      input_tokens: 0,
      output_tokens: 0,
      ...budget,
    };
  }
}
