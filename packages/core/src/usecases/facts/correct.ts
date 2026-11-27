/**
 * What a person does to a fact on the dashboard: correct its words, or say they have checked it.
 * Each is what an agent's `update_fact` does, by the same unit (`onFact`), as the person: the
 * event names them and no session. A correction replaces the words in place and keeps no copy of
 * the old: the log holds the hashes before and after, and the person is correcting text that was
 * wrong, which nothing should keep.
 */
import type {
  FactConfirmation,
  FactConfirmed,
  FactCorrected,
  FactCorrection,
} from "@uketsugi/contracts";
import { liveHeads, scopeOf } from "../../context.ts";
import type { Caller } from "../../domain.ts";
import type { LiveFact } from "../../facts/duplicates.ts";
import { notFound, ToolFailure } from "../../failure.ts";
import type { CorePorts } from "../../ports.ts";
import { scanFields } from "../../scan/scanner.ts";
import { onFact } from "./place.ts";
import { correctionOf, requireAuthor, reworded, visibleFact } from "./write.ts";
import { confirm } from "./update.ts";

type Ports = Pick<CorePorts, "store" | "clock" | "ids" | "embedder">;

/** The fact a person names: one they can see with its text, that nothing has replaced. */
async function liveFact(ports: Ports, caller: Caller, id: string): Promise<LiveFact> {
  const fact = await visibleFact(ports, caller, id);
  if (fact.claim === null) throw notFound("listed fact", id);
  const head = (await liveHeads(ports, scopeOf(caller), [fact])).get(fact.id);
  if (head !== undefined) {
    throw new ToolFailure("conflict", {
      what: `Fact ${fact.id} was merged into ${head}.`,
      meaning: "Nothing was changed: agents receive the fact it was merged into, not this one.",
      next: `Use ${head} instead.`,
    });
  }
  return { ...fact, claim: fact.claim };
}

/**
 * Corrects the claim and the detail of the person's own fact. The text is scanned like any write.
 * Sending what the fact already says changes nothing.
 */
export async function correctFact(
  ports: Ports,
  caller: Caller,
  id: string,
  input: FactCorrection,
): Promise<FactCorrected> {
  const before = await liveFact(ports, caller, id);
  requireAuthor(
    caller,
    before,
    "Only its author corrects a fact. Ask them to, or have your agent flag it and publish what you found.",
  );
  const { claim, detail, replaced } = reworded(before, input);
  if (input.claim.trim() === "") {
    throw new ToolFailure("invalid_input", {
      what: "The claim is empty.",
      meaning: "Nothing was changed.",
      next: "Write the claim as it should read. To take the fact away altogether, redact it.",
    });
  }
  const { question, citations } = before;
  const correction = await correctionOf(ports, before, { claim, detail, question, citations });
  const write = { before, correction, at: ports.clock.now() };
  const changed = await onFact(ports, { caller, session: null }, write);
  return {
    id: before.id,
    changed,
    ...(replaced.length === 0 ? {} : { redacted: replaced }),
  };
}

/**
 * The person's check of a fact they can see, as `update_fact` records it: another person's makes
 * it confirmed, and so does the author's own of a fact a model wrote, which its person is the
 * first to check. The author's of a fact their agent published only refreshes it.
 */
export async function confirmFact(
  ports: Ports,
  caller: Caller,
  id: string,
  input: FactConfirmation,
): Promise<FactConfirmed> {
  const before = await liveFact(ports, caller, id);
  const checked = scanFields({ checked: input.checked }).fields.checked;
  const at = ports.clock.now();
  const acting = { caller, session: null };
  const write = { before, correction: null, at };
  await onFact(ports, acting, write, (unit, fact) =>
    confirm(acting, unit, fact, { checked, sourceVersion: null }, at),
  );
  const fact = await ports.store.facts.get(scopeOf(caller), before.id);
  if (fact === null) throw notFound("listed fact", id);
  return { id: fact.id, status: fact.status };
}
