/**
 * How a session or a server ended, told apart:
 * - capped: the session reached its deadline and was stopped; what it did is judged as it stands;
 * - void, provider: the model's provider refused a call (HTTP 429 or 529, a rate-limit event that
 *   says `rejected`, an API error and no result); void, machine: a box that would not start, or a
 *   server killed by a signal from outside. A void is nobody's miss, and is said;
 * - void, quota: a unit not started because the window was near full; void, clock: a session that
 *   could not start before the run's last start time;
 * - void, baseline: a no-memory session called the memory server, so the baseline was not one;
 * - miss: a server that exited on its own error is the product's;
 * - harness: the harness failed on its own, recorded as itself.
 */
import type { ProcessExit } from "./process.ts";

export type End =
  | { kind: "done" }
  | { kind: "capped"; seconds: number }
  | { kind: "void"; cause: "provider" | "machine" | "quota" | "clock" | "baseline"; detail: string }
  | { kind: "miss"; detail: string }
  | { kind: "harness"; code: number | null; detail: string };

/** What a session left: how long it ran if its deadline stopped it, whether its box started, its exit code, its transcript and its error output. */
export interface Seen {
  readonly capped: number | null;
  /** The run ended the session itself, on purpose (quick mode stops it at its first write). */
  readonly killed: boolean;
  readonly started: boolean;
  readonly code: number | null;
  readonly transcript: string;
  readonly stderr: string;
}

function eventsOf(transcript: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of transcript.split("\n")) {
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // not an event
    }
  }
  return events;
}

/** What the provider refused, when it did: a refused status, a rate-limit event that says `rejected`, or an API error with no result after it. */
export function providerRefusal(transcript: string): string | undefined {
  const events = eventsOf(transcript);
  for (const event of events) {
    const status = event["api_error_status"];
    if (status === 429 || status === 529) return `HTTP ${String(status)}`;
    const info = event["rate_limit_info"] as { status?: unknown } | undefined;
    if (event["type"] === "rate_limit_event" && info?.status === "rejected")
      return "a rate-limit event said rejected";
  }
  const errored = events.find((e) => e["type"] === "assistant" && typeof e["error"] === "string");
  if (errored !== undefined && !events.some((e) => e["type"] === "result"))
    return `an API error (${String(errored["error"])}) with no result`;
  return undefined;
}

export function sessionEnd(seen: Seen): End {
  if (seen.capped !== null) return { kind: "capped", seconds: seen.capped };
  const refused = providerRefusal(seen.transcript);
  if (refused !== undefined) return { kind: "void", cause: "provider", detail: refused };
  if (!seen.started)
    return { kind: "void", cause: "machine", detail: "the box would not start after its retries" };
  if (seen.killed) return { kind: "done" };
  if (seen.code !== 0) return { kind: "harness", code: seen.code, detail: seen.stderr.slice(-300) };
  return { kind: "done" };
}

/** How a server that ended without this run stopping it ended, or undefined while it is up or was stopped here. */
export function serverEnd(exit: ProcessExit | null): End | undefined {
  if (exit === null) return undefined;
  if (exit.signal !== null)
    return { kind: "void", cause: "machine", detail: `the server was killed by ${exit.signal}` };
  if (exit.code !== 0)
    return { kind: "miss", detail: `the server exited with code ${String(exit.code)}` };
  return undefined;
}

/** Thrown by a case that cannot go on because a session ended in a way that is not done or capped: the case's record carries it. */
export class SessionEnded extends Error {
  readonly end: End;

  constructor(end: End) {
    super(end.kind === "done" || end.kind === "capped" ? end.kind : `${end.kind}: ${end.detail}`);
    this.end = end;
  }
}

/** A session's end with what its server did meanwhile: a server that died is the cause unless the session was capped or already void. */
export function endWithServer(session: End, server: End | undefined): End {
  return server === undefined || session.kind === "void" || session.kind === "capped"
    ? session
    : server;
}
