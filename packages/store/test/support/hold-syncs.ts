/**
 * Preload (`node --import`) that records the engine's syncs and lets a test hold them, so that a
 * recovery runs at the test's pace and not the disk's. Worker threads inherit `--import`, so it
 * reaches the recovery's worker as well. It does nothing without HOLD_DIR.
 *
 * Each sync appends `sync <thread> <n>` to HOLD_DIR/log (n counts per thread) before it is made.
 * A worker's syncs, and every thread's with HOLD_ALL=1, then wait until HOLD_DIR/released holds a
 * number at least n. The wait polls a file the test writes: it is not a deadline.
 *
 * The main thread also appends `tick` every 20 ms, which is a turn of its event loop: where a test
 * has sent a signal, two ticks after it show the loop has handled whatever the signal started.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isMainThread } from "node:worker_threads";

const dir = process.env.HOLD_DIR;
if (dir !== undefined) {
  const thread = isMainThread ? "main" : "worker";
  const holds = !isMainThread || process.env.HOLD_ALL === "1";
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const released = (): number => {
    try {
      return Number(fs.readFileSync(`${dir}/released`, "utf8")) || 0;
    } catch {
      return 0;
    }
  };
  const sync = fs.fsyncSync;
  let n = 0;
  fs.fsyncSync = (fd: number) => {
    n += 1;
    fs.appendFileSync(`${dir}/log`, `sync ${thread} ${n}\n`);
    while (holds && released() < n) Atomics.wait(pause, 0, 0, 20);
    sync(fd);
  };
  syncBuiltinESMExports();
  if (isMainThread) setInterval(() => fs.appendFileSync(`${dir}/log`, "tick\n"), 20).unref();
}
