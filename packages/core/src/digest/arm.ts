/**
 * When a session is the model step's to read. Kept apart from the reading itself
 * (`jobs/digest.ts`), because every write that leaves a session something to read asks here.
 */
import { servedByModel } from "../context.ts";
import type { Session } from "../domain.ts";
import type { CorePorts } from "../ports.ts";
import { SESSION_IDLE_MS } from "../sessions.ts";

/**
 * Says a session has left something for the model step: it is read `now` when the session is
 * over, and otherwise once it has been quiet for as long as makes a session lapsed. Nothing is
 * armed on a server with no model, or for a person the model step does not read.
 */
export async function armDigest(
  ports: Pick<CorePorts, "store" | "clock" | "runner">,
  session: Pick<Session, "orgId" | "id" | "principalId">,
  when: "now" | "quiet",
): Promise<void> {
  if (!servedByModel(ports, session)) return;
  const now = ports.clock.now();
  const dueAt = when === "now" ? now : new Date(now.getTime() + SESSION_IDLE_MS);
  await ports.store.jobs.armDigest(session.orgId, session.id, dueAt);
}
