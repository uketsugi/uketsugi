/**
 * What a model's reading may cost, in tokens, since it is the model step's own money. Three
 * bounds hold at once, each for its own harm:
 * - a session's readings together never pass `SESSION_TOKENS`, so one session, however long or
 *   however many turns it holds, cannot cost without limit;
 * - what an organization spends in a day stays within what its operator set (`ModelRunner.dailyTokens`,
 *   the server's on a person's own server), and, where the operator set one, what a person
 *   spends stays within `personDailyTokens`: a reading that would pass either waits, and says why;
 * - a reading that fails after it has cost something is not asked again for what it read: those turns
 *   are deleted, the facts drawn from them written, and the rest waits for the provider.
 * `costOf` is an estimate made before a call, taken high. The provider's own count is what is
 * kept and added up, and a call is asked only while that count so far plus this estimate for the
 * call stays within the bound: the estimate guards the call about to be made, never the total.
 */
import type { Session } from "../domain.ts";
import type { Chore, CorePorts, ModelAnswer, ModelRunner } from "../ports.ts";

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
/** How long a reading that cannot go on now (the day's budget is spent, the provider fails) waits before it looks again. */
export const WAIT_MS = 30 * 60_000;

/** Characters to a token, taken low so that the estimate is high: English text is about four, code and JSON fewer. */
const CHARS_PER_TOKEN = 3;

/** What asking a chore may cost. */
export function costOf(chore: Pick<Chore, "instructions" | "material">): number {
  return (
    Math.ceil((chore.instructions.length + chore.material.length) / CHARS_PER_TOKEN) + ANSWER_TOKENS
  );
}

/**
 * What a call is counted as having cost: the provider's own count, and, for a side it reports as
 * nothing (a call that read a session and answered with nothing is no call that cost nothing),
 * the estimate. A provider that counted nothing would otherwise be no bound on a session's cost.
 */
export function countedFor(
  chore: Pick<Chore, "instructions" | "material">,
  answer: Pick<ModelAnswer, "inputTokens" | "outputTokens">,
): { input: number; output: number } {
  return {
    input: answer.inputTokens > 0 ? answer.inputTokens : costOf(chore) - ANSWER_TOKENS,
    output: answer.outputTokens > 0 ? answer.outputTokens : ANSWER_TOKENS,
  };
}

/** The day's limit that binds a reading: the person's own or the organization's, whichever has less room. */
export interface DayLimit {
  readonly whose: "person" | "organization";
  readonly used: number;
  readonly limit: number;
}

/** What the model has been asked for in the day, against the limits that apply, as the tighter of the two. */
export async function dayLimit(
  ports: Pick<CorePorts, "store"> & { readonly runner: ModelRunner },
  session: Pick<Session, "orgId" | "principalId">,
  since: Date,
): Promise<DayLimit> {
  const { organization, person } = await ports.store.sessions.spentBy(
    session.orgId,
    session.principalId,
    since,
  );
  const ofOrganization = {
    whose: "organization",
    used: organization,
    limit: ports.runner.dailyTokens,
  } as const;
  const own = ports.runner.personDailyTokens;
  if (own === undefined) return ofOrganization;
  const ofPerson = { whose: "person", used: person, limit: own } as const;
  return own - person <= ports.runner.dailyTokens - organization ? ofPerson : ofOrganization;
}

/** Why a reading waits, in words its person reads on the dashboard. It holds counts, never text. */
export function waitingWords(day: DayLimit, used: number): string {
  const share =
    day.whose === "person"
      ? "your own limit"
      : "the limit for everyone in your organization together";
  return (
    `Waiting: ${share} on what the model reads in a day is used up (${used} of ${day.limit} tokens). ` +
    "This is read once earlier use is more than a day old."
  );
}
