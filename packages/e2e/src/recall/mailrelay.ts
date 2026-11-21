/**
 * The chain's mail relay, started once for a case. It binds a port of its own and says which on its
 * first line; the case then asks that port for the token it gave the relay, so that a listener that
 * merely holds the port (another case's relay, anything) is never mistaken for it. Nothing here picks
 * a port and then leaves it to be taken before use.
 */
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { resolveTool, start, stop } from "./process.ts";

export interface MailRelay {
  readonly port: number;
  /** What the relay answers at `GET /token`: the case's proof that it is its own. */
  readonly token: string;
  stop(): Promise<void>;
}

/** The first line of the relay's output: where it listens. */
function portOf(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let said = false;
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    lines.on("line", (line) => {
      if (said) return; // later lines are the relay's events: read, so the pipe never fills
      said = true;
      try {
        resolve((JSON.parse(line) as { port: number }).port);
      } catch {
        reject(new Error(`the mail relay's first line was not its port: ${line.slice(0, 100)}`));
      }
    });
    child.once("close", () => reject(new Error("the mail relay ended before it said its port")));
  });
}

/** What `GET /token` answers at the port, or undefined when nothing answers. */
function tokenAt(port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let body = "";
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("data", (chunk) => (body += chunk.toString()));
    socket.once("close", () =>
      resolve(body.includes("\r\n\r\n") ? body.split("\r\n\r\n")[1]?.trim() : undefined),
    );
    socket.once("error", () => resolve(undefined));
    socket.write("GET /token HTTP/1.0\r\n\r\n");
  });
}

export async function startMailRelay(script: string): Promise<MailRelay> {
  const token = randomUUID();
  const python = resolveTool("python3") ?? "python3";
  const child = start(python, [script, "--port", "0", "--token", token], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    const port = await portOf(child);
    if ((await tokenAt(port)) !== token) {
      throw new Error(
        `the mail relay is not this case's own: port ${port} did not answer with its token`,
      );
    }
    return { port, token, stop: async () => void (await stop(child)) };
  } catch (error) {
    await stop(child);
    throw error;
  }
}
