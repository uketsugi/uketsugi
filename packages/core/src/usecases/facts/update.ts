import type { FlagKind, UpdateFactInput, UpdateFactResult } from "@uketsugi/contracts";
import { eventOf, personActor, scopeOf, type CallContext, type Outcome } from "../../context.ts";
import type { Fact } from "../../domain.ts";
import { citationView, parseCitations } from "../../facts/citations.ts";
import type { LiveFact } from "../../facts/duplicates.ts";
import { forbidden, invalidInput, notFound, unsupported } from "../../failure.ts";
import type { CorePorts } from "../../ports.ts";
import { scanFields, type Replacement } from "../../scan/scanner.ts";
import type { UnitWrites } from "../../store-port.ts";
import { seenBy } from "../../sharing.ts";
import { onFact } from "./place.ts";
import {
  classCitations,
  correctionOf,
  liveFactOf,
  scanCitations,
  type Correction,
} from "./write.ts";

const FLAG_KINDS: Readonly<Record<NonNullable<UpdateFactInput["flag"]>, FlagKind>> = {
  stale: "marked_stale",
  contradiction: "possible_contradiction",
};

/** The flags a newer confirmation clears: doubt about whether the fact still matches its source. */
const CLEARED_BY_A_CHECK: readonly FlagKind[] = ["marked_stale", "source_changed"];

/**
 * The author's correction, read and scanned before the unit opens: the fields the call names
 * replace the fact's, the rest stay. Only the author may change a fact's text.
 */
async function correction(
  ports: CorePorts,
  ctx: CallContext,
  fact: LiveFact,
  input: UpdateFactInput,
): Promise<{ correction: Correction; replaced: Replacement[] }> {
  if (fact.author !== ctx.caller.principalId) {
    throw forbidden(
      `Fact ${fact.id} is another person's, so its text cannot be changed here.`,
      "Confirm it or flag it with update_fact, or publish what you found as a new fact.",
    );
  }
  const text = scanFields({ claim: input.claim, detail: input.detail });
  const claim = text.fields.claim ?? fact.claim;
  const detail = input.detail === undefined ? fact.detail : text.fields.detail;
  const sent =
    input.citations === undefined
      ? null
      : scanCitations(parseCitations(input.citations, ctx.project));
  const citations =
    sent === null
      ? fact.citations
      : await classCitations(ports, ctx.caller, sent.citations, fact.id);
  const next = { claim, detail, question: fact.question, citations };
  return {
    correction: await correctionOf(ports, fact, next),
    replaced: [...text.replaced, ...(sent?.replaced ?? [])],
  };
}

/**
 * A check of the fact. Another person's makes it confirmed; the author's own only refreshes it.
 * Either way it is newer than any doubt about the fact's source, which it clears.
 */
async function confirm(
  ctx: CallContext,
  unit: UnitWrites,
  fact: Fact,
  check: { checked: string | null; sourceVersion: string | null },
  at: Date,
): Promise<void> {
  const person = ctx.caller.principalId;
  await unit.review.confirm({ factId: fact.id, person, at, ...check });
  const cleared = await unit.review.clearFlags(fact.id, CLEARED_BY_A_CHECK);
  if (cleared > 0) {
    const what = { factId: fact.id, kinds: CLEARED_BY_A_CHECK, count: cleared };
    await unit.append(eventOf(ctx, "FlagCleared", fact.id, what));
  }
  if (person === fact.author || fact.status !== "unconfirmed") return;
  await unit.facts.setStatus(fact.id, "confirmed");
  await unit.append(eventOf(ctx, "FactConfirmed", fact.id, { id: fact.id, person }));
}

async function flag(
  ports: CorePorts,
  ctx: CallContext,
  unit: UnitWrites,
  fact: Fact,
  kind: FlagKind,
): Promise<void> {
  const raised = { id: ports.ids.uuid(), factId: fact.id, kind };
  if (!(await unit.review.raiseFlag({ ...raised, raisedBy: personActor(ctx.caller) }))) return;
  await unit.append(eventOf(ctx, "FlagRaised", fact.id, raised));
}

/** Whether the call corrects the fact's text. A move and a call that changes nothing are refused. */
function changesText(input: UpdateFactInput): boolean {
  if ("audience" in input) {
    throw unsupported(
      "update_fact was asked to move the fact to another audience.",
      "Leave audience out: where a fact is seen follows how its person treats the project, and only the person chooses that.",
    );
  }
  const text =
    input.claim !== undefined || input.detail !== undefined || input.citations !== undefined;
  if (!text && input.confirm === undefined && input.flag === undefined) {
    throw invalidInput(
      "update_fact was given nothing to change.",
      "Pass at least one of claim, detail, citations, confirm or flag.",
    );
  }
  return text;
}

/**
 * Changes one fact, field by field (flow F4): the author's correction, a confirmation or a flag.
 * Every text is scanned first. The same change applied twice changes nothing the second time. A
 * call never moves a fact by naming an audience; a correction that changes whether other people
 * can check the fact puts it where it now belongs.
 */
export async function updateFact(
  ports: CorePorts,
  ctx: CallContext,
  input: UpdateFactInput,
): Promise<Outcome<UpdateFactResult>> {
  const corrects = changesText(input);
  const before = await liveFactOf(ports, ctx, input.id, {
    absent: () => notFound("fact", input.id),
    replaced: (fact, head) =>
      invalidInput(
        `Fact ${fact.id} was replaced by ${head}.`,
        `Send the update to ${head}: it is the live fact.`,
      ),
  });
  const corrected = corrects ? await correction(ports, ctx, before, input) : null;
  const check = scanFields({
    "confirm.checked": input.confirm?.checked,
    "confirm.source_version": input.confirm?.source_version,
  });
  const checked = {
    checked: check.fields["confirm.checked"],
    sourceVersion: check.fields["confirm.source_version"],
  };
  const at = ports.clock.now();
  const write = { before, correction: corrected?.correction ?? null, at };
  const rewritten = await onFact(ports, ctx, write, async (unit, fact) => {
    if (input.confirm !== undefined) await confirm(ctx, unit, fact, checked, at);
    if (input.flag !== undefined) await flag(ports, ctx, unit, fact, FLAG_KINDS[input.flag]);
  });

  const scope = scopeOf(ctx.caller);
  const [fact, flags] = await Promise.all([
    ports.store.facts.get(scope, before.id),
    ports.store.review.openFlags(scope, [before.id]),
  ]);
  if (fact === null) throw notFound("fact", input.id);
  const replaced = [...(corrected?.replaced ?? []), ...check.replaced];
  return {
    id: fact.id,
    status: fact.status,
    flags: [...new Set(flags.map((entry) => entry.kind))],
    ...(rewritten && input.citations !== undefined
      ? { citations: fact.citations.map(citationView) }
      : {}),
    ...(replaced.length === 0 ? {} : { redacted: replaced }),
    ...(await seenBy(ports, ctx.caller, fact.id)),
  };
}
