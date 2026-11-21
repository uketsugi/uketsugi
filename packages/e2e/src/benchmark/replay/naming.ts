/**
 * Whether a query names a fact: whether it shares a specific word with it, apart from whether a pass
 * admitted the fact (a generic word such as "channel" admits a fact the query is not about).
 *
 * A shared word is generic when it is a stop word of the product's own keyword search (PostgreSQL's
 * `english` list, which `to_tsvector('english', ...)` drops, so no pass could use it) or when more
 * than a share of the facts in the case's store hold it ("channel" in a ChanServ store). It is
 * specific otherwise. The share is a judgement, 5% as shown, so the report also counts at half and at
 * double it, and a cell is marked `judgement` when that would change its answer: it shares exactly
 * one specific word, or a shared word sits between those two shares.
 */
import { textOf, type ReplayFact } from "./data.ts";

/** A word is generic when more than this share of the store's facts hold it. */
export const GENERIC_SHARE = 0.05;

/** PostgreSQL's `english` stop list (words of 3 letters or more; `wordsOf` drops the shorter). */
const STOP_WORDS = new Set(
  "myself our ours ourselves you your yours yourself yourselves him his himself she her hers herself its itself they them their theirs themselves what which who whom this that these those are was were been being have has had having does did doing the and but because until while for with about against between into through during before after above below from down out off over under again further then once here there when where why how all any both each few more most other some such nor not only own same than too very can will just don should now".split(
    " ",
  ),
);

const WORD = /[\p{L}\p{N}_]{3,}/gu;
export const wordsOf = (text: string): string[] => [
  ...new Set(text.toLowerCase().match(WORD) ?? []),
];

const textWithQuestion = (fact: ReplayFact): string => `${textOf(fact)} ${fact.question ?? ""}`;

export interface Naming {
  /** The query's words (3 letters or more) the best-matching needed fact also holds, with the share of the store's facts that hold each; a stop word has share 1. */
  readonly shared: readonly { readonly word: string; readonly share: number }[];
  /** Of those, the specific ones at `GENERIC_SHARE`. */
  readonly specific: readonly { readonly word: string; readonly share: number }[];
  readonly queryWords: number;
  /** The answer depends on the threshold: see the file's header. */
  readonly judgement: boolean;
}

/** The query's shared and specific words with the needed fact that shares the most specific ones. */
export function namingOf(
  query: string,
  targets: Iterable<ReplayFact>,
  corpus: readonly ReplayFact[],
): Naming {
  const asked = wordsOf(query);
  const held = corpus.map((fact) => new Set(wordsOf(textWithQuestion(fact))));
  const share = (word: string): number =>
    STOP_WORDS.has(word) ? 1 : held.filter((words) => words.has(word)).length / held.length;
  const options = [...targets].map((fact) => {
    const own = new Set(wordsOf(textWithQuestion(fact)));
    const shared = asked
      .filter((word) => own.has(word))
      .map((word) => ({ word, share: share(word) }));
    return { shared, specific: specificAt(shared, GENERIC_SHARE) };
  });
  const best = options.sort(
    (a, b) => b.specific.length - a.specific.length || b.shared.length - a.shared.length,
  )[0] ?? { shared: [], specific: [] };
  const between = best.shared.some(
    (entry) => entry.share > GENERIC_SHARE / 2 && entry.share <= GENERIC_SHARE * 2,
  );
  return { ...best, queryWords: asked.length, judgement: best.specific.length === 1 || between };
}

/** The shared words that a store share of at most `limit` leaves specific. */
export function specificAt(
  shared: Naming["shared"],
  limit: number,
): { word: string; share: number }[] {
  return shared.filter((entry) => entry.share <= limit);
}
