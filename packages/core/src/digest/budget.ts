/**
 * What a model's reading may cost, in tokens, since it is the model step's own money. Three
 * bounds hold at once, each for its own harm:
 * - a session's readings together never pass `SESSION_TOKENS`, so one session, however long or
 *   however many turns it holds, cannot cost without limit;
 * - what a server spends in a day stays within what its operator set (`ModelRunner.dailyTokens`):
 *   a reading that would pass it waits;
 * - a reading that has cost something is not asked again if it fails, so a retry pays nothing twice.
 * A count here is an estimate made before the call, taken high; the provider's own count is what
 * is kept and added up.
 */
import type { Chore } from "../ports.ts";

/** The most all the readings of one session may cost, input and output together: about eight chores of the largest size. */
export const SESSION_TOKENS = 150_000;
/** What a reading keeps back for the two small questions that follow the big ones (judge, choose). */
export const RESERVE_TOKENS = 8_000;
/** The least a daily budget can be and still read anything: one reading's reserve and its answers, with room for what it reads. */
export const MIN_DAILY_TOKENS = 20_000;
/** What an answer may cost: a list of candidate facts is a few hundred tokens, and a model may think first. */
const ANSWER_TOKENS = 2_000;
/** How far back the operator's daily budget looks. */
export const BUDGET_WINDOW_MS = 24 * 3_600_000;
/** How long a reading that is over the budget waits before it looks again: the window frees as the day goes. */
export const BUDGET_WAIT_MS = 30 * 60_000;

/** Characters to a token, taken low so that the estimate is high: English text is about four, code and JSON fewer. */
const CHARS_PER_TOKEN = 3;

/** What asking a chore may cost. */
export function costOf(chore: Pick<Chore, "instructions" | "material">): number {
  return (
    Math.ceil((chore.instructions.length + chore.material.length) / CHARS_PER_TOKEN) + ANSWER_TOKENS
  );
}
