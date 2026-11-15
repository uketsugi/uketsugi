/** What a session that begins does for the model step. Session inference asks here, and nothing here asks it back. */
import { servedByModel } from "../context.ts";
import type { Session } from "../domain.ts";
import type { CorePorts } from "../ports.ts";
import { RUNNING_TURN_MS } from "./record.ts";

/**
 * A session that begins in a project has the model step read, now, what the person's last session
 * there left and it has not read yet: one that was killed never said it was over, and the session
 * that follows it is the one that needs what it found. A conversation that goes on under a new
 * session, because it was quiet for long, is not such a beginning: its last session is its own
 * earlier part, which is read when the conversation ends or falls quiet. Nothing is asked for on
 * a server with no model. A session with a turn asked and not yet answered is still working and
 * is not hastened: it is read when it is over or quiet. One whose last turn was answered is, so
 * that sessions that follow one another closely each start from what the one before found; what
 * such a session says later is read in its turn.
 */
export async function hastenLast(
  ports: Pick<CorePorts, "store" | "runner" | "clock">,
  session: Session,
): Promise<void> {
  const { orgId, principalId, project, id, conversationId, clientName } = session;
  if (project === null || !servedByModel(ports, session)) return;
  const last = await ports.store.sessions.previous(orgId, principalId, project, id);
  if (last === null) return;
  const itsOwnEarlierPart =
    conversationId !== null &&
    last.conversationId === conversationId &&
    last.clientName === clientName;
  if (itsOwnEarlierPart) return;
  const since = new Date(ports.clock.now().getTime() - RUNNING_TURN_MS);
  if (!(await ports.store.sessions.runningTurn(orgId, last.id, since)))
    await ports.store.jobs.hastenDigest(orgId, last.id, session.firstCallAt);
}
