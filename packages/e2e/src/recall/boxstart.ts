/**
 * Starting boxes (the sandbox of `sandbox.ts`) many at a time. Creating a network namespace races
 * when starts overlap: one fails at once with `bwrap: loopback: Failed RTM_NEWADDR`. So starts are
 * spaced, and a start that fails that way is tried again; a box that still will not start after its
 * retries is the machine's fault, not the product's.
 */
const SPACING_MS = 300;
const RETRIES = 3;
const LOOPBACK_FAILURE = "bwrap: loopback: Failed RTM_NEWADDR";

let nextStart = 0;

/** Waits for this start's turn: each start is at least 0.3 s after the one before it. */
export async function spaceBoxStart(): Promise<void> {
  const at = Math.max(Date.now(), nextStart);
  nextStart = at + SPACING_MS;
  if (at > Date.now()) await new Promise((resolve) => setTimeout(resolve, at - Date.now()));
}

export interface Attempt {
  readonly failed: boolean;
  readonly stderr: string;
}

/**
 * Runs `attempt` (one start, and the command's run to its end) until it does not fail on the
 * loopback, at most three more times; `started` is false when it never got past that.
 */
export async function withBoxRetries(
  attempt: () => Promise<Attempt>,
): Promise<{ started: boolean; tries: number }> {
  for (let tries = 1; ; tries++) {
    await spaceBoxStart();
    const done = await attempt();
    if (!done.failed || !done.stderr.includes(LOOPBACK_FAILURE)) return { started: true, tries };
    if (tries > RETRIES) return { started: false, tries };
  }
}
