/**
 * The local adapter of the Embedder port: the pinned model in one worker thread, one text per
 * run, a question ahead of any waiting document. The model directory is verified once, before
 * the worker starts, and the worker starts on the first use or when `load` is called.
 */
import { extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { EmbedError, type Embedder } from "@uketsugi/core";
import { CATALOG, layout, type Catalog } from "./catalog.ts";
import { describe } from "./faults.ts";
import type { WorkerData, WorkerReply } from "./inference-worker.ts";
import { verifyModel, type ModelCheck } from "./verify.ts";

export interface LocalEmbedderOptions {
  readonly catalog?: Catalog;
  /** Threads one run may use inside the runtime. The recorded vectors were made with one. */
  readonly threads?: number;
}

/** The Embedder of a model directory, with its lifecycle. */
export interface LocalEmbedder extends Embedder {
  /**
   * Whether the directory holds the pinned runtime and model, intact. The files are read once:
   * `load` and every text rely on the same answer.
   */
  check(): Promise<ModelCheck>;
  /** Loads the model now, after `check`. Rejects with `EmbedError` saying why it cannot. */
  load(): Promise<void>;
  /** Ends the worker. Every unfinished and later `embed` rejects. */
  close(): Promise<void>;
}

/** One `embed` call: its vectors so far and how it ends. */
interface Call {
  readonly vectors: Float32Array[];
  remaining: number;
  settled: boolean;
  settle(error?: EmbedError): void;
}

interface Job {
  readonly call: Call;
  readonly index: number;
  readonly text: string;
}

/** A loaded worker: one run at a time. */
interface Session {
  run(text: string): Promise<{ dims: readonly number[]; data: Float32Array }>;
  close(): Promise<void>;
}

/** The worker's entry beside this file: `.ts` when running from source, `.js` when built. */
function workerEntry(): URL {
  return new URL(`./inference-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);
}

/** Starts a worker and resolves once its model has loaded. `onExit` is told when a loaded worker ends. */
function startSession(data: WorkerData, onExit: () => void): Promise<Session> {
  return new Promise<Session>((resolve, reject) => {
    const worker = new Worker(workerEntry(), { workerData: data });
    let pending: { resolve: (reply: WorkerReply) => void; reject: (error: Error) => void } | null =
      null;
    let loaded = false;
    let over = false;
    const ended = (why: string): void => {
      // A crash is told twice, as an error and then as an exit: it is one ending.
      if (over) return;
      over = true;
      const error = new Error(`the model's worker ended: ${why}`);
      reject(error);
      pending?.reject(error);
      pending = null;
      if (loaded) onExit();
    };
    worker.on("error", (error) => ended(describe(error)));
    worker.on("exit", (code) => ended(`exit ${code}`));
    worker.on("message", (reply: WorkerReply) => {
      if (reply.kind === "load_failed") reject(new Error(reply.detail));
      else if (reply.kind !== "ready") pending?.resolve(reply);
      else {
        loaded = true;
        // An idle worker must not hold the process open; a run holds it until it answers.
        worker.unref();
        resolve({
          async run(text) {
            worker.ref();
            try {
              const reply = await new Promise<WorkerReply>((resolveRun, rejectRun) => {
                pending = { resolve: resolveRun, reject: rejectRun };
                worker.postMessage(text);
              });
              if (reply.kind !== "ran") throw new Error("detail" in reply ? reply.detail : "");
              return reply;
            } finally {
              pending = null;
              worker.unref();
            }
          },
          close: async () => void (await worker.terminate()),
        });
      }
    });
  });
}

class WorkerEmbedder implements LocalEmbedder {
  readonly model: string;
  readonly dims: number;
  private readonly queries: Job[] = [];
  private readonly documents: Job[] = [];
  private session: Promise<Session> | null = null;
  private checked: Promise<ModelCheck> | null = null;
  private pumping = false;
  private closed = false;
  private readonly root: string;
  private readonly catalog: Catalog;
  private readonly threads: number;

  constructor(root: string, options: LocalEmbedderOptions) {
    this.root = root;
    this.catalog = options.catalog ?? CATALOG;
    this.threads = options.threads ?? 1;
    this.model = this.catalog.embedModel;
    this.dims = this.catalog.dims;
  }

  check(): Promise<ModelCheck> {
    this.checked ??= verifyModel(this.root, this.catalog);
    return this.checked;
  }

  async load(): Promise<void> {
    await this.started();
  }

  embed(
    texts: readonly string[],
    kind: "document" | "query",
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    if (this.closed) return Promise.reject(new EmbedError("the embedder is closed", false));
    if (signal?.aborted === true)
      return Promise.reject(new EmbedError("embedding was aborted", true));
    if (texts.length === 0) return Promise.resolve([]);
    return new Promise<Float32Array[]>((resolve, reject) => {
      const onAbort = (): void => call.settle(new EmbedError("embedding was aborted", true));
      const call: Call = {
        vectors: new Array<Float32Array>(texts.length),
        remaining: texts.length,
        settled: false,
        settle(error) {
          if (call.settled) return;
          call.settled = true;
          signal?.removeEventListener("abort", onAbort);
          if (error === undefined) resolve(call.vectors);
          else reject(error);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const queue = kind === "query" ? this.queries : this.documents;
      texts.forEach((text, index) => queue.push({ call, index, text }));
      void this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const closed = new EmbedError("the embedder is closed", false);
    for (const job of [...this.queries.splice(0), ...this.documents.splice(0)])
      job.call.settle(closed);
    const session = this.session;
    this.session = null;
    await session?.then(
      (live) => live.close(),
      () => undefined,
    );
  }

  /** The loaded worker, started once. A failed load stands until the process restarts. */
  private started(): Promise<Session> {
    if (this.closed) return Promise.reject(new EmbedError("the embedder is closed", false));
    if (this.session === null) {
      const starting: Promise<Session> = this.start(() => {
        // A worker that died after loading is replaced by the next text. Only the session that
        // died is cleared: a replacement may already stand in its place.
        if (this.session === starting) this.session = null;
      });
      this.session = starting;
    }
    return this.session;
  }

  private async start(onExit: () => void): Promise<Session> {
    const check = await this.check();
    if (!check.ok) throw new EmbedError(`the model cannot be used: ${check.detail}`, false);
    const at = layout(this.root, this.catalog);
    const { modelId, dtype, pooling } = this.catalog;
    const data = { entry: at.entry, modelsDir: at.models + sep, modelId, dtype, pooling };
    try {
      return await startSession({ ...data, threads: this.threads }, onExit);
    } catch (error) {
      throw new EmbedError(`the model did not load: ${describe(error)}`, false, { cause: error });
    }
  }

  /** The next text to run: a question before any document, skipping calls that already ended. */
  private next(): Job | undefined {
    for (const queue of [this.queries, this.documents]) {
      for (let job = queue.shift(); job !== undefined; job = queue.shift())
        if (!job.call.settled) return job;
    }
    return undefined;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let job = this.next(); job !== undefined; job = this.next()) await this.run(job);
    } finally {
      this.pumping = false;
    }
  }

  private async run({ call, index, text }: Job): Promise<void> {
    try {
      const session = await this.started();
      const output = await session.run(text).catch((error: unknown) => {
        throw new EmbedError(`the model failed on a text: ${describe(error)}`, true, {
          cause: error,
        });
      });
      const [rows, width] = output.dims;
      if (output.dims.length !== 2 || rows !== 1 || width !== this.dims)
        throw new EmbedError(
          `the model returned a tensor of [${output.dims.join(", ")}], not [1, ${this.dims}]`,
          false,
        );
      call.vectors[index] = output.data;
      call.remaining -= 1;
      if (call.remaining === 0) call.settle();
    } catch (error) {
      const closed = this.closed ? new EmbedError("the embedder is closed", false) : null;
      call.settle(
        closed ?? (error instanceof EmbedError ? error : new EmbedError(describe(error), false)),
      );
    }
  }
}

/**
 * The Embedder of the model directory `root`. It returns at once: the directory is verified and
 * the model loaded on the first `embed` or by `load`.
 */
export function openLocalEmbedder(root: string, options: LocalEmbedderOptions = {}): LocalEmbedder {
  return new WorkerEmbedder(root, options);
}
