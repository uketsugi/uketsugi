/**
 * Inferred sessions, each with its note, the turns its hook left for a model to read and what a
 * model's reading of it came to: the directory records behind session inference, the brief's
 * "previous session", Activity and the model step. A session write takes no audience lock and
 * writes no event.
 */
import {
  MOST_TURNS_KEPT,
  type ActivityRow,
  type DigestFailure,
  type ModelTokens,
  type Session,
  type SessionKey,
  type SessionMark,
  type SessionNote,
  type SessionsRepo,
  type Turn,
} from "@uketsugi/core";
import { sql, type Selectable } from "kysely";
import { inByteOrder, Repo, uuidsOf, type Db } from "./codec.ts";
import type { Database } from "./schema.ts";

/**
 * Whether a session has anything to show for itself: a call, one refused, or a note. A session
 * its harness began and nothing more came of has none: no brief tells of it, Activity does not
 * count it, and it puts no project on its person's list. `table` is the name a statement knows
 * `sessions` by.
 */
export function didSomething(table: "sessions" | "s") {
  const of = sql.raw(table);
  return sql<boolean>`(${of}.calls > 0 or ${of}.refused_calls > 0 or ${of}.note_text is not null)`;
}

/** A note as its three columns hold it; they are set together or not at all (`sessions_note_whole`). */
function noteColumns(note: SessionNote | null) {
  return {
    noteText: note?.text ?? null,
    noteFinal: note?.final ?? null,
    noteAt: note?.at ?? null,
  };
}

/**
 * What a session is read as: every column but the facts chosen for the next brief, which are read
 * by themselves (`picks`) and never with a session.
 */
const COLUMNS = [
  "orgId",
  "id",
  "principalId",
  "displayId",
  "clientName",
  "clientVersion",
  "conversationId",
  "project",
  "firstCallAt",
  "lastCallAt",
  "lastSearchAt",
  "lastPublishAt",
  "refusedCalls",
  "calls",
  "briefedAt",
  "noteText",
  "noteFinal",
  "noteAt",
  "digestedAt",
  "modelInputTokens",
  "modelOutputTokens",
  "digestFailedAt",
  "digestFailure",
] as const;

function toSession(row: Pick<Selectable<Database["sessions"]>, (typeof COLUMNS)[number]>): Session {
  const {
    noteText,
    noteFinal,
    noteAt,
    modelInputTokens,
    modelOutputTokens,
    digestFailedAt,
    digestFailure,
    ...session
  } = row;
  const noted = noteText !== null && noteFinal !== null && noteAt !== null;
  return {
    ...session,
    note: noted ? { text: noteText, final: noteFinal, at: noteAt } : null,
    modelTokens: { input: modelInputTokens, output: modelOutputTokens },
    digestFailure:
      digestFailedAt === null || digestFailure === null
        ? null
        : { at: digestFailedAt, reason: digestFailure },
  };
}

export class SqlSessions extends Repo implements SessionsRepo {
  /** One person's sessions, with no column chosen yet. */
  private mine(orgId: string, principalId: string) {
    return this.db
      .selectFrom("sessions")
      .where("orgId", "=", orgId)
      .where("principalId", "=", principalId);
  }

  /** One person's sessions. */
  private of(orgId: string, principalId: string) {
    return this.mine(orgId, principalId).select(COLUMNS);
  }

  latestOf(key: SessionKey): Promise<Session | null> {
    return this.newest(
      this.of(key.orgId, key.principalId)
        .where("clientName", "=", key.clientName)
        .where("conversationId", "is not distinct from", key.conversationId)
        .where("project", "is not distinct from", key.project),
    );
  }

  // What a model's reading of a session came to is written by a reading alone: a session opens
  // unread, at no cost.
  async open(session: Session): Promise<void> {
    await this.db
      .insertInto("sessions")
      .values({
        orgId: session.orgId,
        id: session.id,
        principalId: session.principalId,
        displayId: session.displayId,
        clientName: session.clientName,
        clientVersion: session.clientVersion,
        conversationId: session.conversationId,
        project: session.project,
        firstCallAt: session.firstCallAt,
        lastCallAt: session.lastCallAt,
        lastSearchAt: session.lastSearchAt,
        lastPublishAt: session.lastPublishAt,
        refusedCalls: session.refusedCalls,
        calls: session.calls,
        briefedAt: session.briefedAt,
        ...noteColumns(session.note),
      })
      .execute();
  }

  /** An update of one session, on the store's connection or in a transaction. */
  private one(orgId: string, id: string, db: Db = this.db) {
    return db.updateTable("sessions").where("orgId", "=", orgId).where("id", "=", id);
  }

  async touch(
    orgId: string,
    id: string,
    at: Date,
    mark: SessionMark,
    version: string | null,
  ): Promise<void> {
    await this.one(orgId, id)
      .set((eb) => ({
        lastCallAt: at,
        clientVersion: eb.fn.coalesce("clientVersion", eb.val(version)),
        ...(mark === "search" ? { lastSearchAt: at } : {}),
        ...(mark === "publish" ? { lastPublishAt: at } : {}),
        ...(mark === "refused"
          ? { refusedCalls: eb("refusedCalls", "+", 1) }
          : { calls: eb("calls", "+", 1) }),
      }))
      .execute();
  }

  async setBriefed(orgId: string, id: string, at: Date | null): Promise<void> {
    await this.one(orgId, id).set({ briefedAt: at }).execute();
  }

  async setNote(orgId: string, id: string, note: SessionNote): Promise<void> {
    await this.one(orgId, id).set(noteColumns(note)).execute();
  }

  async activity(orgId: string, principalId: string, since: Date): Promise<ActivityRow[]> {
    return this.db
      .selectFrom("sessions")
      .select((eb) => [
        "clientName",
        "clientVersion",
        eb.fn.countAll<number>().as("sessions"),
        eb.fn.count<number>("lastSearchAt").as("searched"),
        eb.fn.count<number>("lastPublishAt").as("published"),
        sql<number>`count(*) filter (where refused_calls > 0)`.as("refused"),
      ])
      .where("orgId", "=", orgId)
      .where("principalId", "=", principalId)
      .where("lastCallAt", ">=", since)
      .where(didSomething("sessions"))
      .groupBy(["clientName", "clientVersion"])
      .orderBy(inByteOrder("clientName"))
      .orderBy(inByteOrder("clientVersion"))
      .execute();
  }

  /** The one of some sessions with the most recent call. */
  private async newest(rows: ReturnType<SqlSessions["of"]>): Promise<Session | null> {
    const row = await rows.orderBy("lastCallAt", "desc").orderBy("id", "desc").executeTakeFirst();
    return row === undefined ? null : toSession(row);
  }

  latest(orgId: string, principalId: string, project: string): Promise<Session | null> {
    return this.newest(this.of(orgId, principalId).where("project", "=", project));
  }

  async previous(
    orgId: string,
    principalId: string,
    project: string,
    session: string,
  ): Promise<Session | null> {
    // By its last word: a note is written as each turn ends, long after the session's last call.
    const row = await this.of(orgId, principalId)
      .where("project", "=", project)
      .where("id", "<>", session)
      .where(didSomething("sessions"))
      .orderBy(sql`greatest(last_call_at, note_at)`, "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    return row === undefined ? null : toSession(row);
  }

  latestIn(
    orgId: string,
    principalId: string,
    clientName: string,
    conversationId: string,
  ): Promise<Session | null> {
    return this.newest(
      this.of(orgId, principalId)
        .where("clientName", "=", clientName)
        .where("conversationId", "=", conversationId)
        .where("project", "is not", null),
    );
  }

  async recent(orgId: string, principalId: string, limit: number): Promise<Session[]> {
    const rows = await this.of(orgId, principalId)
      .where(didSomething("sessions"))
      .orderBy("lastCallAt", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
    return rows.map(toSession);
  }

  async byIds(orgId: string, ids: readonly string[]): Promise<Session[]> {
    const wanted = uuidsOf(ids);
    if (wanted.length === 0) return [];
    const rows = await this.db
      .selectFrom("sessions")
      .select(COLUMNS)
      .where("orgId", "=", orgId)
      .where("id", "in", wanted)
      .execute();
    return rows.map(toSession);
  }

  async addTurn(orgId: string, sessionId: string, turn: Turn): Promise<void> {
    const { id, request, answer, at } = turn;
    await this.keepTurn(this.db, { orgId, sessionId, id, request, answer, at });
  }

  /** One statement: the turn's row is kept only while the session holds fewer than `MOST_TURNS_KEPT`. */
  private async keepTurn(db: Db, turn: Selectable<Database["sessionTurns"]>): Promise<void> {
    const { orgId, sessionId, id, request, answer, at } = turn;
    await sql`
      insert into session_turns (org_id, session_id, id, request, answer, at)
      select ${orgId}, ${sessionId}, ${id}, ${request}, ${answer}, ${at}
      where (select count(*) from session_turns
             where org_id = ${orgId} and session_id = ${sessionId}) < ${MOST_TURNS_KEPT}`.execute(
      db,
    );
  }

  async answerTurn(
    orgId: string,
    sessionId: string,
    answered: { id: string; answer: string; at: Date },
  ): Promise<void> {
    const { id, answer, at } = answered;
    await this.db.transaction().execute(async (trx) => {
      const open = await sql<{ id: string }>`
        update session_turns set answer = ${answer}, at = ${at}
        where org_id = ${orgId} and session_id = ${sessionId} and id = (
          select id from session_turns
          where org_id = ${orgId} and session_id = ${sessionId} and answer is null
          order by at desc, id desc limit 1)
        returning id`.execute(trx);
      if (open.rows.length > 0) return;
      await this.keepTurn(trx, { orgId, sessionId, id, request: null, answer, at });
    });
  }

  /** A deletion of one session's turns. */
  private deleteTurns(db: Db, orgId: string, sessionId: string) {
    return db
      .deleteFrom("sessionTurns")
      .where("orgId", "=", orgId)
      .where("sessionId", "=", sessionId);
  }

  async turns(orgId: string, sessionId: string): Promise<Turn[]> {
    return this.db
      .selectFrom("sessionTurns")
      .select(["id", "request", "answer", "at"])
      .where("orgId", "=", orgId)
      .where("sessionId", "=", sessionId)
      .orderBy("at")
      .orderBy("id")
      .execute();
  }

  async dropTurns(orgId: string, sessionId: string): Promise<void> {
    await this.deleteTurns(this.db, orgId, sessionId).execute();
  }

  async digested(
    orgId: string,
    id: string,
    read: { at: Date; turns: readonly string[]; picks?: readonly string[] },
  ): Promise<void> {
    const turns = uuidsOf(read.turns);
    const picks = read.picks === undefined ? {} : { briefPicks: JSON.stringify(read.picks) };
    await this.db.transaction().execute(async (trx) => {
      if (turns.length > 0) {
        await this.deleteTurns(trx, orgId, id).where("id", "in", turns).execute();
      }
      await this.one(orgId, id, trx)
        .set({ digestedAt: read.at, digestFailedAt: null, digestFailure: null, ...picks })
        .execute();
    });
  }

  async digestFailed(orgId: string, id: string, failure: DigestFailure): Promise<void> {
    await this.one(orgId, id)
      .set({
        // The time stays that of the first failure of a run of them: what waits is counted from it.
        digestFailedAt: sql<Date>`coalesce(digest_failed_at, ${failure.at})`,
        digestFailure: failure.reason,
      })
      .execute();
  }

  async spent(orgId: string, id: string, tokens: ModelTokens, at: Date): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.one(orgId, id, trx)
        .set((eb) => ({
          modelInputTokens: eb("modelInputTokens", "+", tokens.input),
          modelOutputTokens: eb("modelOutputTokens", "+", tokens.output),
        }))
        .execute();
      await trx
        .insertInto("modelSpend")
        .values({ orgId, at, tokens: tokens.input + tokens.output })
        .execute();
      // A week is more than any budget looks back over.
      await trx
        .deleteFrom("modelSpend")
        .where("at", "<", new Date(at.getTime() - 7 * 24 * 3_600_000))
        .execute();
    });
  }

  async spentSince(since: Date): Promise<number> {
    const { total } = await this.db
      .selectFrom("modelSpend")
      .select(sql<number>`coalesce(sum(tokens), 0)::int`.as("total"))
      .where("at", ">", since)
      .executeTakeFirstOrThrow();
    return Number(total);
  }

  async runningTurn(orgId: string, sessionId: string, since: Date): Promise<boolean> {
    const open = await this.db
      .selectFrom("sessionTurns")
      .select("id")
      .where("orgId", "=", orgId)
      .where("sessionId", "=", sessionId)
      .where("answer", "is", null)
      .where("at", ">", since)
      .limit(1)
      .executeTakeFirst();
    return open !== undefined;
  }

  async picks(orgId: string, principalId: string, project: string): Promise<string[]> {
    const newest = await this.mine(orgId, principalId)
      .select("briefPicks")
      .where("project", "=", project)
      .where("briefPicks", "is not", null)
      .orderBy("digestedAt", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    return newest?.briefPicks ?? [];
  }
}
