/**
 * The jobs registry: every job over facts is defined here once. A handler is idempotent, works on
 * one record, reads it when it runs (a job carries ids, never text) and makes its changes in units
 * of its own. It resolves when the job is done and rejects when it should be tried again.
 */
import type { ClaimedJob, JobKind } from "../domain.ts";
import { isLive } from "../facts/duplicates.ts";
import type { CorePorts } from "../ports.ts";
import { embedFact } from "../usecases/facts/write.ts";
import { consolidate } from "./consolidate.ts";

export type JobHandler = (ports: CorePorts, job: ClaimedJob) => Promise<void>;

/** How long the embed job waits for the model before it gives the attempt up. */
const EMBED_JOB_BUDGET_MS = 30_000;

/**
 * `embed`: gives a fact the vector its write did not make. A fact that is gone, superseded,
 * redacted or already embedded needs nothing, and neither does any fact on a host with no model:
 * when a model is installed the worker finds every fact without a vector. The vector is stored
 * only while the fact's content is what was embedded; a fact that changed meanwhile is embedded
 * again on the next attempt.
 */
async function embed(ports: CorePorts, job: ClaimedJob): Promise<void> {
  if (ports.embedder === null) return;
  const scope = { orgId: job.orgId, audienceIds: [job.audienceId] };
  const fact = await ports.store.facts.get(scope, job.subject);
  if (!isLive(fact) || fact.embedded) return;
  const vector = await embedFact(ports, fact, EMBED_JOB_BUDGET_MS);
  const stored = await ports.store.facts.setVector(job.orgId, fact.id, fact.contentHash, vector);
  if (!stored) throw new Error("the fact changed while it was embedded");
}

/** Every job this build runs: `embed`, and the rule step of `consolidate`. */
export const JOBS: Readonly<Record<JobKind, JobHandler>> = { embed, consolidate };
