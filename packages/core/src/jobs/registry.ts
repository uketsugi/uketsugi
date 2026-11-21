/**
 * The jobs registry: every job is defined here once. A handler is idempotent, works on one
 * record, reads it when it runs (a job carries ids, never text) and makes its changes in units of
 * its own. It resolves when the job is done and rejects when it should be tried again.
 */
import { scopeOfJob } from "../context.ts";
import type { ClaimedJob, JobKind } from "../domain.ts";
import { isLive } from "../facts/duplicates.ts";
import { EmbedError, type CorePorts } from "../ports.ts";
import { embedFact } from "../usecases/facts/write.ts";
import { consolidate } from "./consolidate.ts";
import { digest, giveUpDigest, type DigestReport } from "./digest.ts";

/** What a handler is given besides its job: what cuts it short, and where a reading's report goes. */
export interface JobRun {
  /** Aborts when the server is stopping. Only a job that may run long needs to listen. */
  readonly halt: AbortSignal;
  readonly onDigest?: (report: DigestReport) => void;
}

export type JobHandler = (ports: CorePorts, job: ClaimedJob, run: JobRun) => Promise<void>;

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
  const fact = await ports.store.facts.get(scopeOfJob(job), job.subject);
  if (!isLive(fact) || fact.embedded) return;
  // A server whose model is not the store's (another server took the store) could never store it.
  const recorded = await ports.store.jobs.embeddingModel();
  if (recorded !== null && recorded !== ports.embedder.model)
    throw new EmbedError(
      `this server's embedding model "${ports.embedder.model}" is not the store's "${recorded}", which another server started later with a different model took; a restart of this server takes it back`,
      false,
    );
  const vector = await embedFact(ports, fact, EMBED_JOB_BUDGET_MS);
  const stored = await ports.store.facts.setVector(job.orgId, fact.id, fact.contentHash, vector);
  if (!stored) throw new Error("the fact changed while it was embedded");
}

/**
 * Every job this build runs: `embed`, the rule step of `consolidate`, and `digest`, a model's
 * reading of a session, which is only ever left on a server that has a model.
 */
export const JOBS: Readonly<Record<JobKind, JobHandler>> = { embed, consolidate, digest };

/** What a job that is given up leaves behind is cleared away here, for the kinds that leave something. */
export const GIVEN_UP: Readonly<
  Partial<Record<JobKind, (ports: CorePorts, job: ClaimedJob) => Promise<void>>>
> = { digest: giveUpDigest };
