import { describe, expect, test } from "vitest";
import type { Caller, Session, SessionKey, SessionNote } from "../src/domain.ts";
import {
  createSessionInference,
  SESSION_IDLE_MS,
  sessionState,
  type ClientInfo,
} from "../src/sessions.ts";

/** What inference is given: of the store, only the sessions it reads and stamps. */
type InferencePorts = Parameters<typeof createSessionInference>[0];

const CALLER: Caller = {
  orgId: "org",
  principalId: "person",
  displayName: "you",
  credentialId: null,
  privateAudienceId: "audience",
  sharedAudienceId: null,
  visibleAudienceIds: ["audience"],
};
const API = "github.com/acme/api";
const WEB = "github.com/acme/web";
const claude: ClientInfo = { name: "claude-code", version: "2.1.323", conversationId: null };
const antigravity = (conversationId: string): ClientInfo => ({
  name: "antigravity",
  version: "1.5.8",
  conversationId,
});

/** Sessions kept in a list, and a clock and ids a test moves by hand. */
function world() {
  const rows: Session[] = [];
  let now = Date.parse("2026-11-13T09:00:00Z");
  let ids = 0;
  const matches = (row: Session, key: SessionKey) =>
    row.orgId === key.orgId &&
    row.principalId === key.principalId &&
    row.clientName === key.clientName &&
    row.conversationId === key.conversationId &&
    row.project === key.project;
  const change = (id: string, to: (row: Session) => Session) => {
    const index = rows.findIndex((row) => row.id === id);
    const row = rows[index];
    if (row !== undefined) rows[index] = to(row);
  };
  const latestFirst = (found: Session[]) =>
    found.sort((a, b) => b.lastCallAt.getTime() - a.lastCallAt.getTime())[0] ?? null;
  const sessions = {
    latestOf: async (key: SessionKey) => latestFirst(rows.filter((row) => matches(row, key))),
    latest: async (_org: string, person: string, project: string) =>
      latestFirst(rows.filter((row) => row.principalId === person && row.project === project)),
    open: async (session: Session) => void rows.push(session),
    touch: async (_org: string, id: string, at: Date, mark: string) =>
      change(id, (row) => ({
        ...row,
        lastCallAt: at,
        lastSearchAt: mark === "search" ? at : row.lastSearchAt,
        lastPublishAt: mark === "publish" ? at : row.lastPublishAt,
        refusedCalls: row.refusedCalls + (mark === "refused" ? 1 : 0),
        calls: row.calls + (mark === "refused" ? 0 : 1),
      })),
    setBriefed: async (_org: string, id: string, at: Date | null) =>
      change(id, (row) => ({ ...row, briefedAt: at })),
    setNote: async (_org: string, id: string, note: SessionNote) =>
      change(id, (row) => ({ ...row, note })),
  };
  const ports = {
    clock: { now: () => new Date(now) },
    ids: { uuid: () => `00000000-0000-7000-8000-${String((ids += 1)).padStart(12, "0")}` },
    store: { sessions },
  } as unknown as InferencePorts;
  return {
    rows,
    sessions: createSessionInference(ports),
    advance: (ms: number) => void (now += ms),
    /** Leaves a note on a session at the clock's reading, as the notes route does. */
    note: (id: string, final: boolean) =>
      sessions.setNote("org", id, { text: "Where the work stands.", final, at: new Date(now) }),
  };
}

describe("session inference", () => {
  test("two projects at once give two sessions", async () => {
    const { sessions, rows } = world();
    const api = await sessions.enter(CALLER, claude, API, "search");
    const web = await sessions.enter(CALLER, claude, WEB, "search");
    const again = await sessions.enter(CALLER, claude, API, "publish");
    expect(web.session.id).not.toBe(api.session.id);
    expect(again.session.id).toBe(api.session.id);
    expect(rows.map((row) => [row.project, row.calls])).toEqual([
      [API, 2],
      [WEB, 1],
    ]);
  });

  test("two clients of one project that send no conversation id merge, by design", async () => {
    const { sessions, rows } = world();
    const one = await sessions.enter(CALLER, claude, API, "search");
    const other = await sessions.enter(CALLER, { ...claude, version: "2.1.325" }, API, "publish");
    expect(other.session.id).toBe(one.session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ calls: 2, clientVersion: "2.1.323" });
    expect(rows[0]?.lastSearchAt).not.toBeNull();
    expect(rows[0]?.lastPublishAt).not.toBeNull();
  });

  test("a conversation id separates two clients of one project", async () => {
    const { sessions } = world();
    const first = await sessions.enter(CALLER, antigravity("conversation-1"), API, "search");
    const second = await sessions.enter(CALLER, antigravity("conversation-2"), API, "search");
    const firstAgain = await sessions.enter(CALLER, antigravity("conversation-1"), API, "search");
    expect(second.session.id).not.toBe(first.session.id);
    expect(firstAgain.session.id).toBe(first.session.id);
  });

  test("a client that starts anew on a connection of its own has a session of its own, at once", async () => {
    const { sessions, advance } = world();
    const on = (connection: string): ClientInfo => ({ ...claude, conversationId: connection });
    const first = await sessions.enter(CALLER, on("connection-1"), API, "search");
    advance(3000);
    const second = await sessions.enter(CALLER, on("connection-2"), API, "search");
    const firstAgain = await sessions.enter(CALLER, on("connection-1"), API, "search");
    expect(second.session.id).not.toBe(first.session.id);
    expect([first.owesBrief, second.owesBrief, firstAgain.owesBrief]).toEqual([true, true, false]);
    expect(firstAgain.session.id).toBe(first.session.id);
  });

  test("a call of no known conversation goes on in its client's open session, whichever conversation opened it", async () => {
    const { sessions, advance, rows } = world();
    const followed: ClientInfo = { ...claude, conversationId: "connection-1" };
    const opened = await sessions.enter(CALLER, followed, API, "search");
    // The server restarts and no longer knows the connection: the same process calls on.
    const after = await sessions.enter(CALLER, claude, API, "publish");
    expect(after.session.id).toBe(opened.session.id);
    expect(after.owesBrief).toBe(false);
    // Another client's session is not this client's to go on in, nor is another project's.
    const other = await sessions.enter(
      CALLER,
      { ...claude, name: "another-client" },
      API,
      "search",
    );
    const elsewhere = await sessions.enter(CALLER, claude, WEB, "search");
    expect([other.owesBrief, elsewhere.owesBrief]).toEqual([true, true]);
    expect(rows).toHaveLength(3);
    // Nor is one that has lapsed.
    advance(SESSION_IDLE_MS + 1);
    const late = await sessions.enter(CALLER, claude, API, "search");
    expect(late.session.id).not.toBe(opened.session.id);
    expect(late.owesBrief).toBe(true);
  });

  test("a call after the idle gap opens a new session; one inside it joins", async () => {
    const { sessions, advance } = world();
    const first = await sessions.enter(CALLER, claude, API, "search");
    advance(SESSION_IDLE_MS - 1);
    const inside = await sessions.enter(CALLER, claude, API, "search");
    advance(SESSION_IDLE_MS + 1);
    const after = await sessions.enter(CALLER, claude, API, "search");
    expect(inside.session.id).toBe(first.session.id);
    expect(after.session.id).not.toBe(first.session.id);
    expect(after.session.displayId).toMatch(/^s-[0-9a-f]{4}$/);
  });

  test("a final note ends its session, a note at a checkpoint does not", async () => {
    const { sessions, advance, note } = world();
    const first = await sessions.enter(CALLER, claude, API, "search");
    advance(60_000);
    await note(first.session.id, false);
    advance(60_000);
    const same = await sessions.enter(CALLER, claude, API, "search");
    expect(same.session.id).toBe(first.session.id);
    expect(same.owesBrief).toBe(false);
    advance(60_000);
    await note(first.session.id, true);
    advance(60_000);
    const next = await sessions.enter(CALLER, claude, API, "search");
    expect(next.session.id).not.toBe(first.session.id);
    expect(next.owesBrief).toBe(true);
  });

  test("two first calls sent at once open one session, and one of them owes the brief", async () => {
    const { sessions, rows } = world();
    const entered = await Promise.all([
      sessions.enter(CALLER, claude, API, "search"),
      sessions.enter(CALLER, claude, API, "search"),
    ]);
    expect(rows).toHaveLength(1);
    expect(entered.map((entry) => entry.owesBrief)).toEqual([true, false]);
  });

  test("a call that failed gives the brief back to the session's next call", async () => {
    const { sessions } = world();
    const first = await sessions.enter(CALLER, claude, API, "other");
    await sessions.releaseBrief(first.session);
    const second = await sessions.enter(CALLER, claude, API, "search");
    const third = await sessions.enter(CALLER, claude, API, "search");
    expect([first.owesBrief, second.owesBrief, third.owesBrief]).toEqual([true, true, false]);
  });

  test("a refused call is counted on a session without a project, which never has a brief", async () => {
    const { sessions, rows } = world();
    const refused = await sessions.enter(CALLER, claude, null, "refused");
    await sessions.enter(CALLER, claude, null, "refused");
    const accepted = await sessions.enter(CALLER, claude, API, "search");
    expect(refused.owesBrief).toBe(false);
    expect(accepted.session.id).not.toBe(refused.session.id);
    expect(rows[0]).toMatchObject({ project: null, refusedCalls: 2, calls: 0, briefedAt: null });
  });
});

describe("where a session stands", () => {
  const at = (minutes: number): Date =>
    new Date(Date.parse("2026-11-13T09:00:00Z") + minutes * 60_000);
  const session = (note: SessionNote | null) => ({ lastCallAt: at(0), note });
  const note = (final: boolean, minutes: number): SessionNote => ({
    text: "x",
    final,
    at: at(minutes),
  });

  test("it is open through the whole idle gap and lapsed after it", () => {
    expect(sessionState(session(null), at(0))).toBe("open");
    expect(sessionState(session(null), new Date(at(0).getTime() + SESSION_IDLE_MS))).toBe("open");
    expect(sessionState(session(null), new Date(at(0).getTime() + SESSION_IDLE_MS + 1))).toBe(
      "lapsed",
    );
  });

  test("only a final note at or after its last call closes it", () => {
    expect(sessionState(session(note(true, 0)), at(1))).toBe("closed");
    expect(sessionState(session(note(true, 5)), at(600))).toBe("closed");
    expect(sessionState(session(note(true, -1)), at(1))).toBe("open");
    expect(sessionState(session(note(false, 5)), at(6))).toBe("open");
    expect(sessionState(session(note(false, 5)), at(600))).toBe("lapsed");
  });
});
