/**
 * Activity, as the dashboard reads it: per client name and version, how many of the person's
 * sessions searched, published and were refused for a missing project, and their recent sessions.
 * It is read from the directory, and only the person's own part of it: nobody sees another
 * person's sessions. Nothing here reads a fact's text.
 */
import type { ActivityParams, ActivityReport, ActivitySession } from "@uketsugi/contracts";
import type { Caller, Session } from "../domain.ts";
import type { CorePorts } from "../ports.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many of the person's sessions "recent sessions" lists. */
const RECENT_SESSIONS = 20;

function sessionRow(session: Session): ActivitySession {
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
