/**
 * What the person's next brief in a project shows first, chosen by a model when the project holds
 * more facts than a brief has room for. The choice is made once, when a session there has been
 * read, from how that session ended; the brief of the next one reads it and asks no model.
 */
import { briefSources } from "../brief-sources.ts";
import { composeBrief } from "../brief.ts";
import type { CorePorts } from "../ports.ts";
import { headOf } from "../render.ts";
import { newSession } from "../sessions.ts";
import { ownFacts } from "../sharing.ts";
import type { Reading } from "./candidates.ts";
import { chooseChore, chosenIn } from "./chores.ts";

/** How much of how the session ended a choice is given. */
const STOPPED_CHARS = 1200;
/** How much of each fact's claim: a brief shows no more of it. */
const CLAIM_CHARS = 170;

/**
 * The facts a model chose for the person's next brief in the project, in order, or null when no
 * choice is needed: everything the project holds fits, or the person wrote too few of its facts
 * for an order to matter. Only the person's own facts are put to the model, as everywhere in the
 * model step; other people's shared facts keep the place the rule gives them.
 */
export async function choosePicks(
  ports: Pick<CorePorts, "store" | "clock" | "ids">,
  reading: Reading,
  stopped: string,
  ask: (chore: ReturnType<typeof chooseChore>) => Promise<unknown>,
): Promise<string[] | null> {
  const { caller, project, session } = reading;
  // The brief as the person's next session here would get it, were it to begin now.
  const { orgId, principalId, clientName } = session;
  const key = { orgId, principalId, clientName, conversationId: null, project: project.key };
  const next = newSession(key, ports.ids.uuid(), null, ports.clock.now());
  const sources = await briefSources(ports, { caller, project, session: next }, null);
  const { brief } = composeBrief(sources);
  if (brief.facts.length >= sources.factCount) return null;
  const pool = sources.facts.map((fact) => fact.id);
  const own = await ownFacts(ports, caller, pool);
  const candidates = sources.facts.filter((fact) => own.has(fact.id));
  if (candidates.length < 2) return null;
  const chore = chooseChore(
    headOf(stopped.trim(), STOPPED_CHARS),
    candidates.map((fact) => headOf(fact.claim, CLAIM_CHARS)),
  );
  const chosen = chosenIn(await ask(chore), candidates.length);
  return chosen.flatMap((index) => candidates[index]?.id ?? []);
}
