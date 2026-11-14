import type { Caller, Store } from "@uketsugi/core";
import { expect, test } from "vitest";
import type { FakeClock, FakeIdGen } from "../fakes.ts";
import { PROJECT } from "./support.ts";

/** What the Store suite lends its session cases: the store under test, a person, and its clock and ids. */
export interface SessionFixture {
  store(): Store;
  person(): Caller;
  readonly clock: FakeClock;
  readonly ids: FakeIdGen;
}

/** How a Store keeps sessions: what inference, a brief and a harness's hooks read of them. */
export function sessionCases(fixture: SessionFixture): void {
  const { clock, ids } = fixture;
  test("a session is read back with its stamps and its note, and a project is created once", async () => {
    const person = fixture.person();
    const { sessions, projects } = fixture.store();
    const key = {
      orgId: person.orgId,
      principalId: person.principalId,
      clientName: "claude-code",
      conversationId: null,
      project: PROJECT,
    };
    const opened = clock.now();
    const stamps = {
      firstCallAt: opened,
      lastCallAt: opened,
      lastSearchAt: null,
      lastPublishAt: null,
    };
    const session = {
      ...key,
      id: ids.uuid(),
      displayId: "s-0001",
      clientVersion: "2.1",
      ...stamps,
      refusedCalls: 0,
      calls: 1,
      briefedAt: null,
      note: null,
    };
    const ref = { kind: "repository" as const, key: PROJECT };
    const first = await projects.ensure(person.orgId, ref, clock.now());
    expect(await projects.ensure(person.orgId, ref, new Date(0))).toEqual(first);
    await sessions.open(session);
    expect(await sessions.latestOf(key)).toEqual(session);
    clock.advance(60_000);
    // A session keeps the version it opened with: a call's own is taken only where it has none.
    await sessions.touch(person.orgId, session.id, clock.now(), "search", "2.2");
    const note = { text: "Stopped after the queue tests.", final: true, at: clock.now() };
    await sessions.setNote(person.orgId, session.id, note);
    const touched = { lastCallAt: clock.now(), lastSearchAt: clock.now(), calls: 2, note };
    expect(await sessions.latestOf(key)).toEqual({ ...session, ...touched });
    expect(await sessions.latestOf({ ...key, project: "github.com/acme/other" })).toBeNull();
    expect(await sessions.latestOf({ ...key, conversationId: "c-1" })).toBeNull();
    const who = [person.orgId, person.principalId, PROJECT] as const;
    expect((await sessions.latest(...who))?.note).toEqual(note);

    // A session its harness began, which has called nothing and left no word: it is its
    // conversation's and its project's latest, and no brief tells of it.
    clock.advance(60_000);
    const begun = {
      ...session,
      ...stamps,
      id: ids.uuid(),
      conversationId: "c-1",
      clientVersion: null,
      firstCallAt: clock.now(),
      lastCallAt: clock.now(),
      calls: 0,
    };
    await sessions.open(begun);
    const mine = [person.orgId, person.principalId] as const;
    expect(await sessions.latest(...who)).toEqual(begun);
    expect(await sessions.latestIn(...mine, "claude-code", "c-1")).toEqual(begun);
    expect(await sessions.latestIn(...mine, "claude-code", "c-2")).toBeNull();
    expect(await sessions.latestIn(...mine, "antigravity", "c-1")).toBeNull();
    const next = ids.uuid();
    expect((await sessions.previous(...who, next))?.id).toBe(session.id);
    expect(await sessions.previous(...who, session.id)).toBeNull();
    await sessions.touch(person.orgId, begun.id, clock.now(), "other", "2.2");
    expect(await sessions.previous(...who, next)).toMatchObject({
      id: begun.id,
      calls: 1,
      clientVersion: "2.2",
    });
    const activity = await sessions.activity(person.orgId, person.principalId, opened);
    expect(activity).toEqual([
      {
        clientName: "claude-code",
        clientVersion: "2.1",
        sessions: 1,
        searched: 1,
        published: 0,
        refused: 0,
      },
      {
        clientName: "claude-code",
        clientVersion: "2.2",
        sessions: 1,
        searched: 0,
        published: 0,
        refused: 0,
      },
    ]);
    const known = await sessions.byIds(person.orgId, [session.id, ids.uuid()]);
    expect(known.map((entry) => entry.clientName)).toEqual(["claude-code"]);
  });
}
