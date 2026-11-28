/**
 * Activity, as the dashboard reads it: per client name and version, how many of the person's
 * sessions searched, published and were refused for a missing project, and their recent sessions,
 * each with the note it left and what the model step spent on it where it read one. It is read from the directory, and
 * only the person's own part of it: nobody sees another person's sessions. Nothing here reads a
 * fact's text.
 */
import type {
  ActivityParams,
  ActivityReport,
  ActivitySession,
  NoteRemoved,
} from "@uketsugi/contracts";
import type { Caller, Session } from "../domain.ts";
import { notFound } from "../failure.ts";
import type { CorePorts } from "../ports.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many of the person's sessions "recent sessions" lists. */
const RECENT_SESSIONS = 20;

function sessionRow(session: Session): ActivitySession {
  const { digestedAt, modelTokens, digestFailure, digestWaiting } = session;
  // A session no model was ever given anything of, and that no reading failed on or waits for, has none to show.
  const unread =
    digestedAt === null &&
    modelTokens.input + modelTokens.output === 0 &&
    digestFailure === null &&
    digestWaiting === null;
  return {
    session: session.displayId,
    client: session.clientName,
    version: session.clientVersion,
    project: session.project,
    first_call_at: session.firstCallAt.toISOString(),
    last_call_at: session.lastCallAt.toISOString(),
    last_search_at: session.lastSearchAt?.toISOString() ?? null,
    last_publish_at: session.lastPublishAt?.toISOString() ?? null,
    refused_calls: session.refusedCalls,
    note:
      session.note === null
        ? null
        : {
            text: session.note.text,
            final: session.note.final,
            at: session.note.at.toISOString(),
          },
    digest: unread
      ? null
      : {
          at: digestedAt?.toISOString() ?? null,
          input_tokens: modelTokens.input,
          output_tokens: modelTokens.output,
          failure:
            digestFailure === null
              ? null
              : { at: digestFailure.at.toISOString(), reason: digestFailure.reason },
          waiting: digestWaiting,
        },
  };
}

/**
 * Activity over the last `days` days. The recording share is read per harness and version: the
 * server cannot see the model, so the client is what it counts by.
 */
export async function activityReport(
  ports: Pick<CorePorts, "store" | "clock">,
  caller: Caller,
  params: ActivityParams,
): Promise<ActivityReport> {
  const since = new Date(ports.clock.now().getTime() - params.days * DAY_MS);
  const { sessions } = ports.store;
  const [rows, recent] = await Promise.all([
    sessions.activity(caller.orgId, caller.principalId, since),
    sessions.recent(caller.orgId, caller.principalId, RECENT_SESSIONS),
  ]);
  return {
    since: since.toISOString(),
    clients: rows.map((row) => ({
      client: row.clientName,
      version: row.clientVersion,
      sessions: row.sessions,
      searched: row.searched,
      published: row.published,
      refused: row.refused,
    })),
    recent: recent.map(sessionRow),
  };
}

/**
 * Removes the note of one of the person's recent sessions, the ones Activity lists, by its display
 * id, with the turns kept for the model step. A session is one person's. What a model already
 * wrote from the note stays as the facts it wrote, which the person corrects or redacts as any
 * other fact.
 */
export async function removeNote(
  ports: Pick<CorePorts, "store">,
  caller: Caller,
  displayId: string,
): Promise<NoteRemoved> {
  const { sessions } = ports.store;
  const recent = await sessions.recent(caller.orgId, caller.principalId, RECENT_SESSIONS);
  const session = recent.find((entry) => entry.displayId === displayId);
  if (session === undefined) throw notFound("listed session", displayId);
  await sessions.clearNote(caller.orgId, session.id);
  return { session: session.displayId };
}
