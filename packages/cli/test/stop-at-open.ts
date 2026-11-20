/**
 * `ukt serve`'s start with a stop that arrives the moment the store is open: the process signals
 * itself from `onStoreOpen`, so the stop is handled while the rest of the start is still going on.
 * It never prints; its exit code and the store's state are what a test reads.
 * Run as: node --conditions=@uketsugi/source stop-at-open.ts <dataDir>
 */
import { endOnSignal, serve } from "../src/serve.ts";
import type { Io } from "../src/report.ts";

/** A start with nothing to ask and nothing to run prints and asks for nothing the test reads. */
const quiet = { out: () => undefined, err: () => undefined } as unknown as Io;
const stopping = endOnSignal();
const options = {
  dataDir: process.argv[2],
  host: "127.0.0.1",
  port: "0",
  onStoreOpen: (close: () => Promise<void>) => {
    stopping.storeOpen(close);
    process.kill(process.pid, "SIGTERM");
  },
};
stopping.started(await serve(quiet, options, {}));
