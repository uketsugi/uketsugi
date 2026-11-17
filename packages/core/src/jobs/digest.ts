/**
 * `digest`, the model step: once a session is over, a model reads what the server holds of it.
 * It runs only on a server whose operator configured a model, and never for a rule's sake: with
 * no model nothing here is armed, and nothing leaves the machine.
 *
 * One reading of a session does three things, each a question to the model (`digest/chores.ts`):
 * 1. It turns what the session's agent said into facts, where the agent published few or none.
 *    Every fact passes what a publish passes and must cite a source the session's own record
 *    names (`digest/candidates.ts`); it is written as its person's, by this job, and names the
 *    session it came from.
 * 2. It judges what a rule cannot: whether one of those facts, or one the agent published in the
 *    session, says the same as a fact already held or contradicts it (`digest/judge.ts`).
 * 3. Where the project holds more facts than a brief shows, it chooses what the person's next
 *    brief there shows first (`digest/picks.ts`).
 *
 * A session's reading is a job in the outbox like any other, the one that is about a session: it
 * is armed by whatever leaves the session something to read (`digest/arm.ts`), for the moment the
 * session says it is over, or for when it has been quiet as long as makes a session lapsed, and
 * it is brought forward when its person begins another session in the project. Each turn is read
 * once and deleted, so the model's tokens grow with what sessions say, never with what the store
 * holds. Every call is one session's, and what it cost is kept with that session.
 *
 * Whose text leaves the machine: only that of a person the runner serves, which on a local server
 * is whoever runs it, who configured the model and so agreed to it. Another person on the same
 * server did not, whatever the operator chose, so their sessions are never armed and their turns
 * never kept (`digest/arm.ts`); and only a person's own facts are put to the model beside theirs.
 */
import { scopeOf } from "../context.ts";
import { armDigest } from "../digest/arm.ts";
import {
  BUDGET_WAIT_MS,
  BUDGET_WINDOW_MS,
  costOf,
  countedFor,
  RESERVE_TOKENS,
  SESSION_TOKENS,
} from "../digest/budget.ts";
import type { Actor, ClaimedJob, FactContent, ModelTokens, Session, Turn } from "../domain.ts";
import { draftOf, type Reading, type Refusal } from "../digest/candidates.ts";
import { candidatesIn, extractChore, judgeChore, verdictsIn } from "../digest/chores.ts";
import {
  comparisonsOf,
  flagContradiction,
  heldAs,
  mergeSame,
  type Subject,
} from "../digest/judge.ts";
import { choosePicks } from "../digest/picks.ts";
import { piecesOf, RUNNING_TURN_MS, saidIn, textOf, type Said } from "../digest/record.ts";
import { isLive, type LiveFact } from "../facts/duplicates.ts";
import { ModelError, type Chore, type CorePorts, type ModelRunner } from "../ports.ts";
import { sessionState } from "../sessions.ts";
import type { JobHandler } from "./registry.ts";
import { headOf } from "../render.ts";
import { writeFact } from "../usecases/facts/publish.ts";
import { embedInline } from "../usecases/facts/write.ts";

/** The ports of a server that has a model. */
type DigestPorts = CorePorts & { readonly runner: ModelRunner };

/** How long a model may take over one question. */
const CHORE_MS = 120_000;
/**
 * How many of the facts a session already recorded a model is told of, the newest, and how much
 * of each: enough to keep it from repeating them.
 */
const MOST_RECORDED = 30;
const RECORDED_CHARS = 200;

/** What one reading of a session did, for whoever runs the server. It holds counts, never text. */
export interface DigestReport {
  /** The session's display id. */
  readonly session: string;
  /** How many turns were read, or 1 for a session read by its note. */
  readonly read: number;
  readonly written: number;
  /** The candidates a model proposed that were not stored, by why. */
  readonly refused: Readonly<Record<Refusal, number>>;
  /** Facts merged into one that says the same. */
  readonly merged: number;
  /** Flags raised on facts that may contradict each other. */
  readonly flagged: number;
  /** Whether the next brief's facts were chosen. */
  readonly chose: boolean;
  /** What the reading's model calls took in and gave out. */
  readonly tokens: ModelTokens;
  /** How many turns were not read because the session had reached what its readings may cost. They are dropped. */
  readonly unread: number;
  /** How many turns were left for a later reading because the day's budget ran out part-way through this one. */
  readonly kept: number;
  /** True for a reading that did not happen: the server's budget for the day is spent, and the session waits. */
  readonly waited: boolean;
  /** What the server has spent on model calls in the last day, and what its operator allows. */
  readonly day: { readonly used: number; readonly limit: number };
}

/** One reading as it goes: who asks, on whose behalf, what the asking has cost so far, and what stops it. */
interface Run {
  readonly ports: DigestPorts;
  readonly reading: Reading;
  readonly by: Actor;
  /** Counted into as the model is asked, so that a reading that fails half-way still says what it cost. */
  readonly spent: { input: number; output: number };
  /** Aborts when the server is stopping: a question in flight is given up, and asked again later. */
  readonly halt: AbortSignal;
}

/** Puts one question to the model, within its time, and counts what it cost: the provider's own count. */
async function ask(run: Pick<Run, "ports" | "spent" | "halt">, chore: Chore): Promise<unknown> {
  const { runner, clock } = run.ports;
  const signal = AbortSignal.any([run.halt, clock.timeout(CHORE_MS)]);
  const answer = await runner.run(chore, signal);
  const counted = countedFor(chore, answer);
  run.spent.input += counted.input;
  run.spent.output += counted.output;
  return answer.output;
}

/** The facts the session's agent published in it that no reading has judged yet. */
async function publishedBy(run: Run, readBefore: Date | null): Promise<LiveFact[]> {
  const { caller, session } = run.reading;
  const scope = scopeOf(caller);
  const ids = await run.ports.store.review.publishedIn(scope, session.id);
  const facts = ids.length === 0 ? [] : await run.ports.store.facts.getMany(scope, ids);
  return facts
    .filter(isLive)
    .filter((fact) => fact.digestSession === null)
    .filter((fact) => readBefore === null || fact.createdAt > readBefore);
}

type Refused = Record<Refusal, number>;

/** What an extraction came to: its drafts, how many pieces were read, and what stopped it if not the end. */
interface Extracted {
  drafts: FactContent[];
  read: number;
  /** `session`: the session's limit, so the rest is dropped. `day`: the day's budget, so the rest waits. */
  stoppedBy: "session" | "day" | null;
}

/**
 * The facts a model finds in what the session's agent said, each as a publish would store it. The
 * pieces are read in order, and a piece is told what the pieces before it gave. Every citation is
 * held against the piece it came from, which is the text the model was shown and no other.
 *
 * A piece is asked only while what the provider has counted for this reading so far, with the
 * estimate for this piece (taken high) and what the two closing questions keep back, stays within
 * the session's `room` and the day's `dayRoom`. Counting what was spent and not the estimate of all
 * that is to come is what lets a session be read as far as its limit allows; the estimate of the
 * piece about to be asked is what keeps the limit from being passed.
 */
async function extract(
  run: Run,
  pieces: readonly (readonly Said[])[],
  recorded: readonly string[],
  room: { session: number; day: number },
  refused: Refused,
): Promise<Extracted> {
  const drafts: FactContent[] = [];
  let read = 0;
  for (const piece of pieces) {
    const known = [...recorded, ...drafts.map((draft) => draft.claim)]
      .slice(-MOST_RECORDED)
      .map((claim) => headOf(claim, RECORDED_CHARS));
    const chore = extractChore(piece, known);
    const needed = run.spent.input + run.spent.output + costOf(chore) + RESERVE_TOKENS;
    if (needed > room.session) return { drafts, read, stoppedBy: "session" };
    if (needed > room.day) return { drafts, read, stoppedBy: "day" };
    const { candidates, malformed } = candidatesIn(await ask(run, chore));
    read += 1;
    refused.invalid += malformed;
    const shown = textOf(piece);
    for (const candidate of candidates) {
      const draft = await draftOf(run.ports, run.reading, shown, candidate);
      if (typeof draft === "string") refused[draft] += 1;
      else if (drafts.some((other) => other.claimHash === draft.claimHash)) refused.repeat += 1;
      else drafts.push(draft);
    }
  }
  return { drafts, read, stoppedBy: null };
}

/** What asking a piece may cost beyond its text: room for the claims it is told of. */
const KNOWN_TOKENS = 2_000;

/**
 * What the pieces would cost by the estimate, as many as `room` allows. This is what a reading
 * that cannot be done now is held for: the estimate is high, so a day's budget is waited for
 * on the safe side, and the reading itself goes on by what the provider counts (`extract`).
 */
function estimatedCost(pieces: readonly Said[][], room: number): number {
  let cost = 0;
  for (const piece of pieces) {
    const next = costOf(extractChore(piece, [])) + KNOWN_TOKENS;
    if (cost + next > room - RESERVE_TOKENS) break;
    cost += next;
  }
  return cost;
}

/** What the writing of one reading came to. */
interface Written {
  written: number;
  merged: number;
  flagged: number;
}

/**
 * Judges the drafts and the session's own published facts against what the person's memory holds
 * near them, in one question, and writes what stands: a draft that says nothing new is not
 * stored, a published fact that does is merged into the one it repeats, and two facts that cannot
 * both be true are flagged.
 */
async function judgeAndWrite(
  run: Run,
  drafts: readonly FactContent[],
  published: readonly LiveFact[],
  refused: Refused,
): Promise<Written> {
  const { ports, reading, by } = run;
  const subjects: Subject[] = [
    ...drafts.map((draft) => ({ claim: draft.claim, fact: null })),
    ...published.map((fact) => ({ claim: fact.claim, fact })),
  ];
  const comparisons = await comparisonsOf(ports, reading, subjects);
  const pairs = comparisons.map(({ n, a, b }) => ({ n, a, b }));
  const verdicts =
    pairs.length === 0 ? new Map<number, never>() : verdictsIn(await ask(run, judgeChore(pairs)));
  const near = (subject: number, verdict: "same" | "contradicts") =>
    heldAs(comparisons, verdicts, subject, verdict);
  const done: Written = { written: 0, merged: 0, flagged: 0 };
  /** Flags the fact against each recorded fact the model said subject `index` contradicts. */
  const flagContradicted = async (index: number, factId: string): Promise<void> => {
    for (const other of near(index, "contradicts")) {
      done.flagged += await flagContradiction(ports, reading, by, [factId, other.id]);
    }
  };
  const writer = {
    caller: reading.caller,
    project: reading.project.key,
    actor: by,
    session: reading.session.id,
    digested: true,
  };
  for (const [index, content] of drafts.entries()) {
    const draft = { id: ports.ids.uuid(), content, vector: await embedInline(ports, content) };
    const stored = near(index, "same").length > 0 ? null : await writeFact(ports, writer, draft);
    if (stored?.created !== true) {
      refused.repeat += 1;
      continue;
    }
    done.written += 1;
    await flagContradicted(index, stored.fact.id);
  }
  for (const [offset, fact] of published.entries()) {
    const index = drafts.length + offset;
    done.merged += await mergeSame(ports, reading, by, fact, near(index, "same"));
    await flagContradicted(index, fact.id);
  }
  return done;
}

/** Whose session a job is about; null when the session, its person or its project is gone. */
async function readingOf(ports: DigestPorts, job: ClaimedJob): Promise<Reading | null> {
  const { store } = ports;
  const [session] = await store.sessions.byIds(job.orgId, [job.subject]);
  if (session === undefined || session.project === null) return null;
  const [caller, project] = await Promise.all([
    store.directory.callerOf(session.orgId, session.principalId),
    store.projects.find(session.orgId, session.project),
  ]);
  return caller === null || project === null ? null : { caller, project, session };
}

/** The turns of a session as a reading finds them: those it may read, those still being worked on, and those lost. */
function sortedTurns(session: Session, turns: readonly Turn[], now: Date) {
  const closed = sessionState(session, now) === "closed";
  const unanswered = turns.filter((turn) => turn.answer === null);
  const running = closed
    ? []
    : unanswered.filter((turn) => now.getTime() - turn.at.getTime() < RUNNING_TURN_MS);
  return {
    answered: turns.filter((turn) => turn.answer !== null),
    running,
    lost: unanswered.filter((turn) => !running.includes(turn)),
  };
}

/**
 * Records that a reading is done: the session is stamped as read, and the turns it answered are
 * deleted. What the day's budget kept the reading from stays, to be read once, later; what the
 * session's limit kept it from is dropped. Returns how many turns stay.
 */
async function closeReading(
  run: Run,
  turns: ReturnType<typeof sortedTurns>,
  done: {
    startedAt: Date;
    turnsRead: number;
    stoppedBy: "session" | "day" | null;
    picks: readonly string[] | null;
  },
): Promise<number> {
  const { ports, reading } = run;
  const { session } = reading;
  const { startedAt, turnsRead, stoppedBy, picks } = done;
  const waiting = stoppedBy === "day" ? turns.answered.slice(turnsRead) : [];
  const finished = turns.answered.slice(0, turns.answered.length - waiting.length);
  await ports.store.sessions.digested(session.orgId, session.id, {
    at: startedAt,
    // Whatever was answered is gone with this reading, read or not; a turn still running or waiting stays.
    turns: [...finished, ...turns.lost].map((turn) => turn.id),
    ...(picks === null ? {} : { picks }),
  });
  if (waiting.length > 0) {
    await ports.store.jobs.armDigest(
      session.orgId,
      session.id,
      new Date(startedAt.getTime() + BUDGET_WAIT_MS),
    );
  }
  if (turns.running.length > 0) await armDigest(ports, session, "quiet");
  return waiting.length;
}

/**
 * Reads one session: what its agent said since the last reading, and what it published. When it
 * is done the session is stamped as read and the turns it read are deleted, in one step. A turn
 * that has no answer yet is a turn being worked on: it is neither read nor deleted, and the
 * session is looked at again later. A session that said nothing a model could read and published
 * nothing costs no call at all, and one whose readings have cost what a session may, or whose
 * reading would take the server past its budget for the day, asks nothing: the first drops what
 * it could not read, the second waits.
 */
async function read(run: Run): Promise<DigestReport> {
  const { ports, reading } = run;
  const { session } = reading;
  const { sessions, jobs } = ports.store;
  // What arrives while the reading runs is newer than this, and is the next reading's.
  const startedAt = ports.clock.now();
  const turns = sortedTurns(session, await sessions.turns(session.orgId, session.id), startedAt);
  const said = saidIn(turns.answered, session.note, session.digestedAt);
  const published = await publishedBy(run, session.digestedAt);
  // A session's room for readings, and whether there is any left for more than its closing questions.
  const room = SESSION_TOKENS - session.modelTokens.input - session.modelTokens.output;
  const pieces = piecesOf(said);
  // Nothing is asked of a session that left nothing, or whose room is spent.
  const asking = !(said.length === 0 && published.length === 0) && room >= RESERVE_TOKENS;
  const limit = ports.runner.dailyTokens;
  const used = await sessions.spentSince(new Date(startedAt.getTime() - BUDGET_WINDOW_MS));
  const nothing = { written: 0, merged: 0, flagged: 0 };
  const refused: Refused = { invalid: 0, uncited: 0, repeat: 0 };
  const report = (more: Partial<DigestReport>): DigestReport => ({
    session: session.displayId,
    read: 0,
    ...nothing,
    refused,
    chose: false,
    tokens: { ...run.spent },
    unread: 0,
    kept: 0,
    waited: false,
    day: { used: used + run.spent.input + run.spent.output, limit },
    ...more,
  });
  /** The reading waits as a whole, for a later one when the day's budget has room again. */
  const waitWhole = async (): Promise<DigestReport> => {
    await jobs.armDigest(session.orgId, session.id, new Date(startedAt.getTime() + BUDGET_WAIT_MS));
    return report({ waited: true });
  };
  if (asking && used + estimatedCost(pieces, room) + RESERVE_TOKENS > limit) return waitWhole();
  const recorded = published.map((fact) => fact.claim);
  // Neither the session's limit nor the day's budget is passed, by what the provider counts.
  const {
    drafts,
    read: piecesRead,
    stoppedBy,
  } = asking
    ? await extract(run, pieces, recorded, { session: room, day: limit - used }, refused)
    : { drafts: [], read: 0, stoppedBy: null };
  const turnsRead = pieces.slice(0, piecesRead).flat().length;
  // The day's budget ran out before anything was read: the reading waits as a whole, as above.
  if (stoppedBy === "day" && turnsRead === 0) return waitWhole();
  const written = asking ? await judgeAndWrite(run, drafts, published, refused) : nothing;
  const stopped = said.at(-1)?.answer ?? session.note?.text ?? "";
  const picks = asking
    ? await choosePicks(ports, reading, stopped, (chore) => ask(run, chore))
    : null;
  const kept = await closeReading(run, turns, { startedAt, turnsRead, stoppedBy, picks });
  return report({
    read: turnsRead,
    unread: stoppedBy === "session" ? said.length - turnsRead : 0,
    kept,
    ...written,
    chose: picks !== null,
  });
}

/**
 * A reading that failed after it had cost something is not asked again: a retry would pay for
 * every question it already paid for, and for the same failure. Only a failure before any cost is
 * left to the worker's retries.
 */
function paidFor(error: unknown, spent: { input: number; output: number }): unknown {
  if (!(error instanceof ModelError) || !error.retryable || spent.input + spent.output === 0)
    return error;
  return new ModelError(
    `${error.message} (the reading had cost tokens, so it is not asked again)`,
    false,
  );
}

/**
 * `digest`'s handler. On a server that has no model (it was restarted without the one that armed
 * the job) nothing is read, and what waited to be read is deleted: no model will read it. What
 * the model was asked is counted on the session whether the reading finished or failed.
 */
export const digest: JobHandler = async (ports, job, { halt, onDigest }) => {
  const { runner, store } = ports;
  if (runner === undefined) return giveUpDigest(ports, job);
  const withModel = { ...ports, runner };
  const reading = await readingOf(withModel, job);
  if (reading === null) return giveUpDigest(ports, job);
  const by: Actor = { kind: "job", job: "digest", runner: runner.kind };
  const spent = { input: 0, output: 0 };
  try {
    const report = await read({ ports: withModel, reading, by, spent, halt });
    onDigest?.(report);
  } catch (error) {
    // A server that is stopping gives up a question that will be asked again, which is not a failure to pay for.
    if (halt.aborted) throw error;
    // The reason a person is shown is the provider's, which a `ModelError` carries without the key.
    if (error instanceof ModelError) {
      const failure = { at: ports.clock.now(), reason: error.message };
      // Keeping the reason must not hide the failure it is the reason of.
      await store.sessions.digestFailed(job.orgId, job.subject, failure).catch(() => undefined);
    }
    throw paidFor(error, spent);
  } finally {
    if (spent.input + spent.output > 0) {
      await store.sessions.spent(job.orgId, job.subject, spent, ports.clock.now());
    }
  }
};

/** What a reading that is given up leaves: the turns it could not read are deleted with it. */
export function giveUpDigest(ports: Pick<CorePorts, "store">, job: ClaimedJob): Promise<void> {
  return ports.store.sessions.dropTurns(job.orgId, job.subject);
}
