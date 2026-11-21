/** How `ukt` runs another program of this machine's: the service manager. */
import { execFile } from "node:child_process";
import type { Io } from "./report.ts";

/** How long a program may run unless it is told more. A program that waits for an answer nobody gives ends here. */
const RUN_WITHIN_MS = 120_000;

/** `Io.run` for a real terminal. A program that is not on the PATH is null; one that ran is its code and its output. */
export const runProgram: Io["run"] = (program, args, { env, within = RUN_WITHIN_MS }) =>
  new Promise((resolve) => {
    const child = execFile(
      program,
      [...args],
      { env, timeout: within, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) resolve({ code: 0, stdout, stderr });
        else if (error.code === "ENOENT") resolve(null);
        else resolve({ code: typeof error.code === "number" ? error.code : 1, stdout, stderr });
      },
    );
    // Nothing is sent to it, so a program that reads its input is not left waiting.
    child.stdin?.end();
  });
