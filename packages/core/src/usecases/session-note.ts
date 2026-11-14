/**
 * A session's note: where it stands, in the agent's own last words, sent by a harness hook or a
 * script. A note at a checkpoint replaces the session's note and the session goes on; a final note
 * ends the session, so the next call opens a new one whose brief shows it.
 */
import { LIMITS, type SessionNoteRequest, type SessionNoteResult } from "@uketsugi/contracts";
import type { Caller, Project, Session } from "../domain.ts";
import { invalidInput } from "../failure.ts";
import type { CorePorts } from "../ports.ts";
import { parseProject, projectRefusal, resolveProject } from "../project.ts";
import { scanText } from "../scan/scanner.ts";
import { newSession, sessionState } from "../sessions.ts";

type NotePorts = Pick<CorePorts, "store" | "clock" | "ids">;

/**
 * How much of a note the scanner reads: twice what is kept. An agent's last message can be as long
 * as a request may be, and only its beginning is kept, so the rest is never read; the margin is so
 * that a secret lying across the cut is found whole before the cut is made.
 */
const SCANNED_CHARS = 2 * LIMITS.closing_note_chars;

/** The origin remote of a directory on this machine, where the server can read it; else null. */
export type OriginOf = (cwd: string) => Promise<string | null>;

/**
 * The session a note is about, when the caller named a project: the person's session there with
 * the most recent call, however long ago, unless it has closed. A closed session has had its last
 * word, and a harness that never called a tool has no session, so the note opens one for itself.
 */
async function sessionIn(
  ports: NotePorts,
  caller: Caller,
  project: Project,
  client: string | undefined,
): Promise<Session> {
  const { orgId, principalId } = caller;
  const now = ports.clock.now();
  const latest = await ports.store.sessions.latest(orgId, principalId, project.key, null);
  if (latest !== null && sessionState(latest, now) !== "closed") return latest;
  const clientName = client ?? "closing-note";
  const key = { orgId, principalId, clientName, conversationId: null, project: project.key };
  const session = newSession(key, ports.ids.uuid(), null, now);
  await ports.store.sessions.open(session);
  return session;
}

/**
 * The project a note names, by its project or by its working directory's origin remote; null when
 * it names none the server can read. A named project that is unknown is refused.
 */
async function projectOfNote(
  ports: NotePorts,
  caller: Caller,
  input: SessionNoteRequest,
  originOf: OriginOf | undefined,
): Promise<Project | null> {
  const origin = input.project ?? (input.cwd === undefined ? null : await originOf?.(input.cwd));
  const ref = parseProject(origin);
  if (ref === null) return null;
  const project = await resolveProject(ports, caller, ref);
  if (project === null) throw await projectRefusal(ports, caller);
  return project;
}

/** The person's open session: the most recent one in a project that has not closed and called within the idle gap. */
async function openSessionOf(ports: NotePorts, caller: Caller): Promise<Session | null> {
  const now = ports.clock.now();
  const recent = await ports.store.sessions.recent(caller.orgId, caller.principalId, 5);
  const open = (session: Session) =>
    session.project !== null && sessionState(session, now) === "open";
  return recent.find(open) ?? null;
}

/**
 * Records where a session stands. The note's beginning is scanned like any write and kept (an
 * agent's last message leads with what it did), private to the person, and shown to the person's
 * next session in the project. A session has one note: a later one replaces it.
 *
 * A caller that names a project reaches the person's latest session there. One that sends only a
 * working directory whose origin the server cannot read reaches the person's open session, and is
 * refused when there is none: a note in the wrong project would mislead the next session there.
 */
export async function recordSessionNote(
  ports: NotePorts,
  caller: Caller,
  input: SessionNoteRequest,
  originOf?: OriginOf,
): Promise<SessionNoteResult> {
  const scanned = scanText(input.text.trim().slice(0, SCANNED_CHARS));
  const text = scanned.text.slice(0, LIMITS.closing_note_chars);
  if (text === "") {
    throw invalidInput("The note is empty.", "Send the agent's last message as `text`.");
  }
  if (input.project === undefined && input.cwd === undefined) {
    throw invalidInput(
      "The note names no project.",
      "Send `project` as a tool call names it, or `cwd`, the session's working directory.",
    );
  }
  const named = await projectOfNote(ports, caller, input, originOf);
  const guessed = named === null && input.project === undefined;
  const session =
    named !== null
      ? await sessionIn(ports, caller, named, input.client)
      : guessed
        ? await openSessionOf(ports, caller)
        : null;
  const project = session?.project ?? null;
  if (session === null || project === null) throw await projectRefusal(ports, caller);
  const note = { text, final: input.final, at: ports.clock.now() };
  await ports.store.sessions.setNote(caller.orgId, session.id, note);
  return { session: session.displayId, project, redactions: [...scanned.rules] };
}
