/**
 * From a model's candidate to a fact that may be stored. A candidate passes everything a publish
 * passes, in the same order and by the same code: the tool's own schema, the scanner, the parsing
 * and classing of its citations. Two rules are a model's alone, because nobody checked what it
 * wrote: it must cite a source others can open that the session's record itself names, and it must
 * not say again what its person's memory already holds.
 */
import { scopeOf, type CallContext } from "../context.ts";
import type { ClassedCitation, FactContent } from "../domain.ts";
import { classify } from "../facts/citations.ts";
import { nearFacts, sameClaim } from "../facts/duplicates.ts";
import { ToolFailure } from "../failure.ts";
import type { CorePorts } from "../ports.ts";
import { scanned } from "../usecases/facts/publish.ts";
import { contentOf } from "../usecases/facts/write.ts";
import { validateInput } from "../validate.ts";
import type { Candidate } from "./chores.ts";
import { bornOut } from "./record.ts";

/**
 * Why a candidate is not stored: it is not a fact a publish would take (`invalid`), the session's
 * record names no source others can open for it (`uncited`), or its person's memory holds it
 * already (`repeat`).
 */
export type Refusal = "invalid" | "uncited" | "repeat";

/** Whose session was read, and where: the person a model's facts are written for. */
export type Reading = Pick<CallContext, "caller" | "project" | "session">;

/**
 * The candidate's words as a publish takes them, scanned, with the citations the record bears out
 * and others can open. A model cites no fact and no person: what it knows is the record.
 */
function wordsOf(reading: Reading, record: string, candidate: Candidate) {
  const { claim, citations, detail, question } = candidate;
  const input = validateInput("publish_fact", {
    project: reading.project.key,
    claim,
    citations: [...citations],
    ...(detail.trim() === "" ? {} : { detail }),
    ...(question.trim() === "" ? {} : { question }),
  });
  const draft = scanned(reading.project, input);
  const open: ClassedCitation[] = draft.citations
    .flatMap((citation) => bornOut(record, citation) ?? [])
    .map((citation) => classify(citation, () => false))
    .filter((entry) => entry.class === "checkable");
  return { ...draft.text, citations: open };
}

/**
 * The fact a candidate would be, or why it is not stored. `record` is the whole text the session
 * left, which every citation is held against.
 */
export async function draftOf(
  ports: Pick<CorePorts, "store">,
  reading: Reading,
  record: string,
  candidate: Candidate,
): Promise<FactContent | Refusal> {
  if (candidate.citations.length === 0) return "uncited";
  let words: ReturnType<typeof wordsOf>;
  try {
    words = wordsOf(reading, record, candidate);
  } catch (error) {
    if (error instanceof ToolFailure) return "invalid";
    throw error;
  }
  if (words.citations.length === 0) return "uncited";
  const { caller, project } = reading;
  const near = await nearFacts(ports.store, scopeOf(caller), project.key, words.claim);
  const held = near.some(
    (fact) => fact.author === caller.principalId && sameClaim(fact.claim, words.claim),
  );
  return held ? "repeat" : contentOf(words);
}
