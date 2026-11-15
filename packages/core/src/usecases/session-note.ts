/**
 * A session's note: where it stands, in the agent's own last words, sent by its harness's hook as
 * each turn ends. A session has one note: a later one replaces it and the session goes on. When
 * the harness says the conversation has ended, the note it left becomes its last word: the session
 * is closed, and the brief of the person's next session in the project shows the note. A session
 * that is killed never says so, and its latest note is what the next brief has of it.
 *
 * A word goes on the session of its own conversation, by the harness's id of it, never on
 * whichever session the person has open in the project: two harnesses at work in one project each
 * keep their own.
 */
import { LIMITS } from "@uketsugi/contracts";
import type { Caller, Session } from "../domain.ts";
import type { CorePorts } from "../ports.ts";
import { parseProject, resolveProject } from "../project.ts";
import { scanText } from "../scan/scanner.ts";
import { sessionState, type ClientInfo, type SessionInference } from "../sessions.ts";

/** What a session's word is recorded with: the store and the clock, and the one opener of sessions. */
export interface NotePorts extends Pick<CorePorts, "store" | "clock"> {
  readonly sessions: SessionInference;
}

/** The conversation a hook speaks for. */
export interface Conversation {
  /** The harness's name, as its MCP client gives it on a call. */
  readonly client: string;
  /** The harness's own id of the conversation. */
  readonly id: string;
  /** The project the conversation works in, as a call would name it, where its hook can say. */
  readonly project: unknown;
}

/**
 * How much of a message the scanner reads. An agent's last message can be as long as a request
 * may be and only its beginning is kept, so the rest is never read.
 */
const READ_CHARS = 16 * LIMITS.closing_note_chars;

/**
 * The beginning of a message as it may be kept: scanned like any write, then cut. A message longer
 * than what is read may have a secret cut short where the reading stops, which no rule then knows,
 * and a scan that took much out ahead of it would bring that end into what is kept. So of such a
 * message nothing is kept that could be a cut secret's beginning: the scanned text less as much as
 * was read beyond what is kept.
 */
function keptOf(message: string): string {
  const whole = message.trim();
  const scanned = scanText(whole.slice(0, READ_CHARS)).text;
  const beyond = READ_CHARS - LIMITS.closing_note_chars;
  const sure =
    whole.length <= READ_CHARS ? scanned : scanned.slice(0, Math.max(0, scanned.length - beyond));
  return sure.slice(0, LIMITS.closing_note_chars).trim();
}

/**
 * The session a conversation's word goes on, if it is to go anywhere. Where the hook names the
 * project, that is the conversation's session there, opened if `opening` and it has none that
 * has not closed: a conversation that made no call and was never begun has none, and one that
 * goes on after its session closed has none open. Where the hook cannot name the project (a
 * directory with no origin remote), it is the conversation's latest session, which a call of its
 * agent opened, and nothing is opened.
 */
async function sessionOf(
  ports: NotePorts,
  caller: Caller,
  of: Conversation,
  opening: boolean,
): Promise<Session | null> {
  const { orgId, principalId } = caller;
  const { sessions } = ports.store;
  const ref = parseProject(of.project);
  const project = ref === null ? null : await resolveProject(ports, caller, ref);
  const client: ClientInfo = { name: of.client, version: null, conversationId: of.id };
  if (project !== null && opening) return ports.sessions.continued(caller, client, project.key);
  const latest =
    project === null
      ? await sessions.latestIn(orgId, principalId, of.client, of.id)
      : await sessions.latestOf({
          orgId,
          principalId,
          clientName: of.client,
          conversationId: of.id,
          project: project.key,
        });
  const going = latest !== null && sessionState(latest, ports.clock.now()) !== "closed";
  return going ? latest : null;
}

/**
 * Records where a conversation's session stands: the beginning of the agent's last message,
 * scanned like any write and kept private to the person. Returns the session it was put on; null
 * where the message holds nothing to keep or there is no session to put it on.
 */
export async function noteSession(
  ports: NotePorts,
  caller: Caller,
  of: Conversation,
  message: string,
): Promise<Session | null> {
  const text = keptOf(message);
  if (text === "") return null;
  const session = await sessionOf(ports, caller, of, true);
  if (session === null) return null;
  const note = { text, final: false, at: ports.clock.now() };
  await ports.store.sessions.setNote(caller.orgId, session.id, note);
  return { ...session, note };
}

/**
 * Ends a conversation's session, as of now: the note it left becomes its last word. A session
 * that made calls and finished no turn has no note, and closes without a word. One that only
 * began (no call, no note) is left as it is: it says nothing of how work stands, and no brief
 * tells of it. Returns the session it closed; null where there is none to close.
 */
export async function endSession(
  ports: NotePorts,
  caller: Caller,
  of: Conversation,
): Promise<Session | null> {
  const session = await sessionOf(ports, caller, of, false);
  if (session === null || (session.note === null && session.calls === 0)) return null;
  const note = { text: session.note?.text ?? "", final: true, at: ports.clock.now() };
  await ports.store.sessions.setNote(caller.orgId, session.id, note);
  return { ...session, note };
}
