/**
 * The outbox worker (flow F8): it claims the follow-up jobs units left, runs each job's handler
 * outside any transaction, and retires the row. A claim is a lock that expires, so a worker that
 * dies loses nothing; a job that fails waits and is tried again, and one that keeps failing is
 * marked dead and left for a person. The worker runs inside the server's process and keeps time
 * only through the Clock port.
 *
 * A model's reading of a session (`digest`) is one of those jobs. It is the one job that is about
 * a session, is armed outside a unit and may take minutes, so it is also the one a stopping
 * server cuts short.
 */
import type { ClaimedJob } from "../domain.ts";
import type { CorePorts } from "../ports.ts";
import type { JobsRepo, Store } from "../store-port.ts";
import type { DigestReport } from "./digest.ts";
import { GIVEN_UP, JOBS } from "./registry.ts";

/** How many jobs one claim takes. */
const BATCH = 20;
/**
 * How long a claim holds a job: a handler that outlives it may see the job run twice, which every
 * handler bears. A reading of a session can outlive it (it is up to ten model calls of up to two
 * minutes each), and this is harmless only while one server process works a store: the worker
 * settles what it claimed one job at a time and claims again only when it has finished, so it
 * never claims its own running reading. A second process on the same store could claim it after
 * this long and spend its tokens again; the lock would then have to be renewed between calls.
 */
const LOCK_MS = 60_000;
/** A job that has failed this many times is dead. */
const MAX_ATTEMPTS = 5;
/** The longest the worker sleeps when nothing wakes it: a job waiting to be retried is found within this. */
const POLL_MS = 5_000;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 3_600_000;

/** How long a job waits after its `attempts`-th failure: 10 s, 20 s, 40 s and so on, an hour at most. */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * BASE_BACKOFF_MS, MAX_BACKOFF_MS);
}

export interface WorkerOptions {
  /** Told of every job that failed, and whether that failure made it dead. */
  readonly onFailure?: (job: ClaimedJob, error: unknown, dead: boolean) => void;
  /** Told of every session a model has read, with what the reading did and cost. */
  readonly onDigest?: (report: DigestReport) => void;
}

export interface Worker {
  /** The store to give the use cases: a unit that leaves a job wakes the worker once it has committed. */
  readonly store: Store;
  /** Starts the loop: it runs what is due, then sleeps until a unit leaves a job or the poll interval passes. */
  start(): void;
  /** Runs every job that is due now, and resolves to how many it settled. */
  drain(): Promise<number>;
  /**
   * Ends the loop for good and resolves once the pass that is running has finished. A question to
   * a model that is in flight is given up, and its session is read again by the next worker.
   */
  stop(): Promise<void>;
}

/** Whether the error itself says a retry cannot help, as a non-retryable `EmbedError` or `ModelError` does. */
function isFinal(error: unknown): boolean {
  return typeof error === "object" && error !== null && "retryable" in error && !error.retryable;
}

/**
 * One pass over the outbox: claims what is due in bounded batches until a claim comes back short.
 * The first pass of a worker that has a model first leaves an `embed` job for every fact without a
 * vector: those published while the host had no model.
 */
function passOver(
  ports: CorePorts,
  options: WorkerOptions,
  halt: AbortSignal,
): () => Promise<number> {
  const { jobs } = ports.store;
  let owesVectors = ports.embedder !== null;
  const run = { halt, onDigest: options.onDigest };

  async function settle(job: ClaimedJob): Promise<void> {
    try {
      await JOBS[job.kind](ports, job, run);
    } catch (error) {
      // A job the server's stopping cut short did not fail: it is due again when the server is back.
      if (halt.aborted) return jobs.fail(job, ports.clock.now());
      const dead = job.attempts >= MAX_ATTEMPTS || isFinal(error);
      const retryAt = new Date(ports.clock.now().getTime() + backoffMs(job.attempts));
      await jobs.fail(job, dead ? null : retryAt);
      if (dead) await GIVEN_UP[job.kind]?.(ports, job);
      options.onFailure?.(job, error, dead);
      return;
    }
    await jobs.complete(job);
  }

  return async () => {
    if (owesVectors) {
      await jobs.embedMissing(ports.clock.now());
      owesVectors = false;
    }
    let settled = 0;
    for (;;) {
      if (halt.aborted) return settled;
      const claimed = await jobs.claim(ports.clock.now(), LOCK_MS, BATCH);
      for (const job of claimed) await settle(job);
      settled += claimed.length;
      if (claimed.length < BATCH) return settled;
    }
  };
}

/** The jobs of a store, with `kick` called once a session's reading is made due now. */
function kickingJobs(jobs: JobsRepo, kick: () => void, now: () => Date): JobsRepo {
  const sooner: Pick<JobsRepo, "armDigest" | "hastenDigest"> = {
    async armDigest(orgId, sessionId, dueAt) {
      await jobs.armDigest(orgId, sessionId, dueAt);
      if (dueAt <= now()) kick();
    },
    async hastenDigest(...args) {
      await jobs.hastenDigest(...args);
      kick();
    },
  };
  // A repository's methods are its class's, so it is wrapped, not spread.
  return new Proxy(jobs, {
    get: (target, key, receiver): unknown =>
      key === "armDigest" || key === "hastenDigest"
        ? sooner[key]
        : Reflect.get(target, key, receiver),
  });
}

/** A store whose units call `kick` once they have committed a job, as does a session's reading armed for now. */
function kicking(store: Store, kick: () => void, now: () => Date): Store {
  return {
    ...store,
    jobs: kickingJobs(store.jobs, kick, now),
    async unit(target, fn) {
      let enqueued = false;
      const result = await store.unit(target, (unit) =>
        fn({
          ...unit,
          async on(audienceId) {
            const reached = await unit.on(audienceId);
            return {
              ...reached,
              async enqueue(job) {
                await reached.enqueue(job);
                enqueued = true;
              },
            };
          },
          async enqueue(job) {
            await unit.enqueue(job);
            enqueued = true;
          },
        }),
      );
      if (enqueued) kick();
      return result;
    },
  };
}

/** The outbox worker over the given ports. */
export function createWorker(ports: CorePorts, options: WorkerOptions = {}): Worker {
  let stopped = true;
  let loop: Promise<void> = Promise.resolve();
  let running: Promise<number> | null = null;
  let wake: (() => void) | null = null;
  let kicked = false;
  // A handler's own units leave jobs too (a merge leaves its survivor to be embedded again):
  // they wake the worker like any other.
  const store = kicking(ports.store, kick, () => ports.clock.now());
  // Stopping gives up a question to a model that is in flight: a provider may take minutes.
  const halting = new AbortController();
  const pass = passOver({ ...ports, store }, options, halting.signal);

  /** One pass at a time: a request made while a pass runs gets a pass of its own after it. */
  function drain(): Promise<number> {
    const mine: Promise<number> = (running ?? Promise.resolve(0))
      .catch(() => 0)
      .then(pass)
      .finally(() => {
        if (running === mine) running = null;
      });
    running = mine;
    return mine;
  }

  function kick(): void {
    kicked = true;
    wake?.();
  }

  /** Resolves when a unit leaves a job, the poll interval passes or the worker stops. */
  function sleep(): Promise<void> {
    if (kicked) return Promise.resolve();
    return new Promise((resolve) => {
      wake = resolve;
      ports.clock.timeout(POLL_MS).addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async function run(): Promise<void> {
    while (!stopped) {
      kicked = false;
      // A pass that fails (the store is closing, say) is tried again at the next wake.
      await drain().catch(() => 0);
      if (!stopped) await sleep();
      wake = null;
    }
  }

  return {
    store,
    start() {
      if (!stopped) return;
      stopped = false;
      loop = run();
    },
    drain,
    async stop() {
      stopped = true;
      halting.abort();
      kick();
      await loop;
      await running?.catch(() => 0);
    },
  };
}
