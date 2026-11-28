import type { BriefFact } from "@uketsugi/contracts";
import type { BriefSources } from "../src/brief.ts";
import type { Session, SessionNote, Task, TaskNote } from "../src/domain.ts";

/** What the brief's tests compose briefs from. */
export const NOW = new Date("2026-11-13T12:00:00Z");
export const ME = "person-me";
export const PROJECT = "github.com/acme/api";
export const minutes = (count: number): Date => new Date(NOW.getTime() + count * 60_000);
export const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

export function task(n: number, title: string, change: Partial<Task> = {}): Task {
  return {
    orgId: "org",
    id: id(n),
    audienceId: "audience",
    project: PROJECT,
    title,
    description: null,
    state: "open",
    version: 1,
    tracked: false,
    publisher: ME,
    lease: null,
    createdAt: minutes(-600),
    updatedAt: minutes(-60),
    ...change,
  };
}

export function lease(holder: string, expiresAt: Date): Task["lease"] {
  return { tokenHash: "aa", holder, session: id(900), expiresAt };
}

export function note(taskNumber: number, text: string, kind: TaskNote["kind"] = "note"): TaskNote {
  const about = { orgId: "org", taskId: id(taskNumber), id: id(500 + taskNumber) };
  return { ...about, kind, author: ME, session: id(901), text, at: minutes(-90) };
}

export function previous(change: Partial<Session> = {}): Session {
  return {
    orgId: "org",
    principalId: ME,
    clientName: "claude-code",
    conversationId: null,
    project: PROJECT,
    id: id(800),
    displayId: "s-0800",
    clientVersion: "2.1.323",
    firstCallAt: minutes(-300),
    lastCallAt: minutes(-240),
    lastSearchAt: minutes(-290),
    lastPublishAt: minutes(-240),
    refusedCalls: 0,
    calls: 9,
    briefedAt: null,
    note: null,
    digestedAt: null,
    modelTokens: { input: 0, output: 0 },
    digestFailure: null,
    digestWaiting: null,
    ...change,
  };
}

/** A session's note: its last word unless `final` is false, which makes it a note at a checkpoint. */
export function noted(text: string, at: Date, final = true): SessionNote {
  return { text, final, at };
}

export const fact = (
  n: number,
  claim: string,
  trust: BriefFact["trust"] = "unreviewed",
): BriefFact => ({
  id: id(n),
  claim,
  trust,
});

export function sources(change: Partial<BriefSources> = {}): BriefSources {
  return {
    project: PROJECT,
    notice: null,
    now: NOW,
    person: ME,
    sessionId: id(801),
    tasks: [],
    notes: [],
    names: new Map([[ME, "you"]]),
    sessions: new Map([[id(900), previous({ id: id(900) })]]),
    previous: null,
    facts: [],
    told: [],
    factCount: 0,
    ...change,
  };
}
