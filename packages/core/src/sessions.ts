/**
 * Sessions are inferred by the server: no call passes one. A call joins the open
 * session of the same person, client name, conversation and project, or opens a new one. The
 * conversation is the client's own id where it sends one, else the connection its transport saw
 * the call arrive on. Every call is stamped on its session, so a session that is killed still
 * leaves what it did and when, and the next brief can say so.
 */
import AsyncLock from "async-lock";
import type { Caller, Session, SessionKey, SessionMark } from "./domain.ts";
import type { CorePorts } from "./ports.ts";

/** A session whose last call is older than this is over: the next call opens a new one. */
export const SESSION_IDLE_MS = 10 * 60 * 1000;

/**
 * Where a session stands. `closed`: it said it was done, with a final note at or after its last
 * call. `open`: it has not, and it called within the idle gap, so it may still be running.
 * `lapsed`: it stopped calling and never said it was done.
 */
export type SessionState = "open" | "closed" | "lapsed";

/** The one statement of whether a session is open: inference, the brief and a note all read it. */
export function sessionState(
  session: Pick<Session, "lastCallAt" | "note">,
  now: Date,
): SessionState {
  const { lastCallAt, note } = session;
  if (note?.final === true && note.at.getTime() >= lastCallAt.getTime()) return "closed";
  return now.getTime() - lastCallAt.getTime() <= SESSION_IDLE_MS ? "open" : "lapsed";
}

/** What a client says of itself on a call. No call passes a session. */
export interface ClientInfo {
  /** The client's name as it reports it, or `unknown`. */
  readonly name: string;
  readonly version: string | null;
  /**
   * The conversation the call belongs to: the client's own id where it sends one, else the id its
   * transport gave the connection the call came on. Null where neither is known.
   */
  readonly conversationId: string | null;
}

/** The session a call belongs to, and whether this call's result is the one to carry its brief. */
export interface Entered {
  readonly session: Session;
  /** True for one call of a session: the first, or the next after a first that failed. */
  readonly owesBrief: boolean;
}

/** The inference of one server process. */
export interface SessionInference {
  /**
   * The session of a call, with the call stamped on it. A refused call has no project and is
   * counted on a session without one, which never has a brief.
   */
  enter(
    caller: Caller,
    client: ClientInfo,
    project: string | null,
    mark: SessionMark,
  ): Promise<Entered>;
  /** Gives the brief back when the result that was to carry it failed: the next call owes it. */
  releaseBrief(session: Session): Promise<void>;
}

/** A session that begins at `now` and has made no call yet. */
export function newSession(
  key: SessionKey,
  id: string,
  version: string | null,
  now: Date,
): Session {
  return {
    ...key,
    id,
    displayId: `s-${id.slice(-4)}`,
    clientVersion: version,
    firstCallAt: now,
    lastCallAt: now,
    lastSearchAt: null,
    lastPublishAt: null,
    refusedCalls: 0,
    calls: 0,
    briefedAt: null,
    note: null,
  };
}

/**
 * Session inference over the store. Two calls of one key are taken one at a time within this
 * process, so two first calls sent at once open one session and one of them owes the brief. The
 * embedded store has one owning process; a deployment of several needs the same guarantee from
 * its database.
 */
export function createSessionInference(
  ports: Pick<CorePorts, "store" | "clock" | "ids">,
): SessionInference {
  const turns = new AsyncLock();
  const { sessions } = ports.store;

  /**
   * The open session a call goes on in, if there is one. A call of no known conversation goes on
   * in its client's open session in the project, whichever conversation opened that: the server
   * was restarted while the client's connection lived on, and the conversation is the same one.
   */
  async function openSessionOf(key: SessionKey, now: Date): Promise<Session | null> {
    const open = (session: Session | null) =>
      session !== null && sessionState(session, now) === "open" ? session : null;
    const own = open(await sessions.latestOf(key));
    if (own !== null || key.conversationId !== null || key.project === null) return own;
    const last = open(await sessions.latest(key.orgId, key.principalId, key.project, null));
    return last?.clientName === key.clientName ? last : null;
  }

  async function enterNow(
    key: SessionKey,
    client: ClientInfo,
    mark: SessionMark,
  ): Promise<Entered> {
    const now = ports.clock.now();
    const refused = mark === "refused";
    const latest = await openSessionOf(key, now);
    if (latest !== null) {
      await sessions.touch(key.orgId, latest.id, now, mark);
      const owesBrief = !refused && latest.briefedAt === null;
      if (owesBrief) await sessions.setBriefed(key.orgId, latest.id, now);
      return { session: latest, owesBrief };
    }
    const session: Session = {
      ...newSession(key, ports.ids.uuid(), client.version, now),
      lastSearchAt: mark === "search" ? now : null,
      lastPublishAt: mark === "publish" ? now : null,
      refusedCalls: refused ? 1 : 0,
      calls: refused ? 0 : 1,
      briefedAt: refused ? null : now,
    };
    await sessions.open(session);
    return { session, owesBrief: !refused };
  }

  return {
    enter(caller, client, project, mark) {
      const key: SessionKey = {
        orgId: caller.orgId,
        principalId: caller.principalId,
        clientName: client.name,
        conversationId: client.conversationId,
        project,
      };
      return turns.acquire(JSON.stringify(Object.values(key)), () => enterNow(key, client, mark));
    },
    releaseBrief: (session) => sessions.setBriefed(session.orgId, session.id, null),
  };
}
