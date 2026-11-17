/**
 * The worker thread that holds the model. It imports the runtime from the model directory by
 * path, builds one session, and answers one text at a time in the order received. It imports
 * nothing of this workspace, so it runs the same from source and from a build.
 */
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { describe } from "./faults.ts";

/** What a worker is started with. */
export interface WorkerData {
  /** The file path of transformers.js's build for Node. */
  readonly entry: string;
  /** The directory that holds the model's directory, with a trailing separator. */
  readonly modelsDir: string;
  readonly modelId: string;
  readonly dtype: string;
  readonly pooling: "cls" | "mean";
  /** Threads one run may use inside the runtime. */
  readonly threads: number;
}

/** What a worker posts: once whether it loaded, then one answer per text. */
export type WorkerReply =
  | { readonly kind: "ready" }
  | { readonly kind: "load_failed"; readonly detail: string }
  /** A row-major tensor of `dims`; `data`'s buffer is transferred. */
  | { readonly kind: "ran"; readonly dims: readonly number[]; readonly data: Float32Array }
  | { readonly kind: "run_failed"; readonly detail: string };

type Extractor = (
  texts: string[],
  options: { pooling: WorkerData["pooling"]; normalize: true },
) => Promise<{ dims: number[]; data: Float32Array }>;

interface Transformers {
  env: { allowRemoteModels: boolean; localModelPath: string };
  pipeline(task: "feature-extraction", model: string, options: object): Promise<Extractor>;
}

const data = workerData as WorkerData;
const port = parentPort;
if (port === null) throw new Error("the inference worker was started outside a worker thread");

const post = (reply: WorkerReply, transfer: ArrayBuffer[] = []): void =>
  port.postMessage(reply, transfer);

async function load(): Promise<Extractor | null> {
  try {
    const transformers = (await import(pathToFileURL(data.entry).href)) as Transformers;
    // The model is read from disk and nowhere else: nothing is fetched at load.
    transformers.env.allowRemoteModels = false;
    transformers.env.localModelPath = data.modelsDir;
    const extractor = await transformers.pipeline("feature-extraction", data.modelId, {
      dtype: data.dtype,
      device: "cpu",
      session_options: { intraOpNumThreads: data.threads },
    });
    post({ kind: "ready" });
    return extractor;
  } catch (error) {
    post({ kind: "load_failed", detail: describe(error) });
    return null;
  }
}

const extractor = await load();
if (extractor !== null) {
  let answered = Promise.resolve();
  port.on("message", (text: string) => {
    answered = answered.then(async () => {
      try {
        // One text per run: a vector never depends on what it was batched with.
        const out = await extractor([text], { pooling: data.pooling, normalize: true });
        const copy = Float32Array.from(out.data);
        post({ kind: "ran", dims: out.dims, data: copy }, [copy.buffer]);
      } catch (error) {
        post({ kind: "run_failed", detail: describe(error) });
      }
    });
  });
}
