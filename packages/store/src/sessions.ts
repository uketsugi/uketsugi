/**
 * Inferred sessions, each with its note: the directory records behind session inference, the
 * brief's "previous session" and Activity. A session write takes no audience lock and writes no
 * event.
 */
import type {
  ActivityRow,
  Session,
  SessionKey,
  SessionMark,
  SessionNote,
  SessionsRepo,
} from "@uketsugi/core";
import { sql, type Selectable } from "kysely";
import { inByteOrder, Repo, uuidsOf } from "./codec.ts";
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

function toSession(row: Selectable<Database["sessions"]>): Session {
  const { noteText, noteFinal, noteAt, ...session } = row;
  const noted = noteText !== null && noteFinal !== null && noteAt !== null;
  return { ...session, note: noted ? { text: noteText, final: noteFinal, at: noteAt } : null };
}

export class SqlSessions extends Repo implements SessionsRepo {
  /** One person's sessions. */
  private of(orgId: string, principalId: string) {
    return this.db
      .selectFrom("sessions")
      .selectAll()
      .where("orgId", "=", orgId)
      .where("principalId", "=", principalId);
  }

  latestOf(key: SessionKey): Promise<Session | null> {
    return this.newest(
      this.of(key.orgId, key.principalId)
        .where("clientName", "=", key.clientName)
        .where("conversationId", "is not distinct from", key.conversationId)
        .where("project", "is not distinct from", key.project),
    );
  }

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

  /** An update of one session. */
  private one(orgId: string, id: string) {
    return this.db.updateTable("sessions").where("orgId", "=", orgId).where("id", "=", id);
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
      .selectAll()
      .where("orgId", "=", orgId)
      .where("id", "in", wanted)
      .execute();
    return rows.map(toSession);
  }
}
