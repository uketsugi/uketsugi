/**
 * The worker thread of `recoverEngine`: starts the engine on the directory, which recovers it, and
 * closes it, which shuts it down cleanly, telling the main thread each sync on the way.
 */
import { parentPort, workerData } from "node:worker_threads";
import { startEngine } from "./embedded.ts";
import type { WorkerMessage } from "./recovery.ts";

const port = parentPort;
if (port === null) throw new Error("recover-worker.ts runs as a worker thread");
const tell = (message: WorkerMessage): void => port.postMessage(message);

let count = 0;
const engine = await startEngine((workerData as { engineDir: string }).engineDir, undefined, () => {
  count += 1;
  tell({ kind: "synced", count });
});
tell({ kind: "closing" });
await engine.close();
