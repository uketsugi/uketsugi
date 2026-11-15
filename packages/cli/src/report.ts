/**
 * What every verb gives back and how it is shown. A verb returns a `Report`: data for `--json`,
 * lines for a person. A verb that cannot do its work throws a `CliFailure`. Either way one thing
 * is printed: the lines, or with `--json` one envelope on one line.
 */
import type { ErrorParts } from "@uketsugi/contracts";

/** A failure in the three parts every failure has: what happened, what it means, what to do next. */
export type Failure = Readonly<Pick<ErrorParts, "what" | "meaning" | "next">>;

export class CliFailure extends Error {
  readonly failure: Failure;
  /** What the verb had established before it failed, for `--json`. */
  readonly data: Readonly<Record<string, unknown>> | undefined;
  constructor(failure: Failure, data?: Readonly<Record<string, unknown>>) {
    super(failure.what);
    this.name = "CliFailure";
    this.failure = failure;
    this.data = data;
  }
}

export interface Report {
  readonly data: Readonly<Record<string, unknown>>;
  readonly lines: readonly string[];
  /** Set by a verb that ran to its end and found a fault in what it reports on. */
  readonly failure?: Failure;
}

/** The one shape `--json` prints. */
export interface Envelope {
  readonly ok: boolean;
  readonly command: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly error?: Failure;
}

/**
 * One long step, as a person watches it: its title on a line of its own, and under it the part
 * that changes.
 */
export interface Progress {
  /** `done` of `total` bytes; `total` is null when it is not known. */
  update(label: string, done: number, total: number | null): void;
  stop(message: string): void;
}

/** How a program of this machine's ended, and what it printed. */
export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Everything a verb reaches outside the server and the data directory. */
export interface Io {
  /** Whether a person is at the terminal, so a question can be asked and a browser opened. */
  readonly interactive: boolean;
  out(line: string): void;
  err(line: string): void;
  confirm(question: string): Promise<boolean>;
  progress(title: string): Progress;
  /** Opens a URL in the person's browser; false when none could be opened. */
  open(url: string): Promise<boolean>;
  /**
   * Runs a program of this machine's and waits for it to end: the service manager. `env` is the
   * whole environment it gets, and its PATH is where the program is looked for. Null when there
   * is no such program.
   */
  run(
    program: string,
    args: readonly string[],
    options: { readonly env: NodeJS.ProcessEnv },
  ): Promise<Ran | null>;
}

/** The last line a program printed that says anything: what a person is shown of a command that failed. */
export function lastLine(ran: Ran): string {
  const lines = `${ran.stdout}\n${ran.stderr}`.split("\n").filter((line) => line.trim() !== "");
  return lines.at(-1)?.trim() ?? `it ended with code ${ran.code}`;
}

/** An error in a sentence a person can be shown: its message, or whatever was thrown. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The failure of an error no verb expected. */
function unexpected(error: unknown): Failure {
  return {
    what: describe(error),
    meaning: "The command stopped before it finished.",
    next: "Run `ukt doctor` to check the installation, then try again.",
  };
}

function printFailure(io: Io, failure: Failure): void {
  io.err(failure.what);
  io.err(failure.meaning);
  io.err(`Next: ${failure.next}`);
}

/** Runs a verb and prints its outcome. Returns the process's exit code: 0, or 1 on any failure. */
export async function runVerb(
  io: Io,
  command: string,
  json: boolean,
  verb: () => Promise<Report>,
): Promise<number> {
  let envelope: Envelope;
  let lines: readonly string[] = [];
  try {
    const report = await verb();
    lines = report.lines;
    const error = report.failure === undefined ? {} : { error: report.failure };
    envelope = { ok: report.failure === undefined, command, data: report.data, ...error };
  } catch (error) {
    const failed = error instanceof CliFailure ? error : new CliFailure(unexpected(error));
    const data = failed.data === undefined ? {} : { data: failed.data };
    envelope = { ok: false, command, ...data, error: failed.failure };
  }
  if (json) io.out(JSON.stringify(envelope));
  else {
    for (const line of lines) io.out(line);
    if (envelope.error !== undefined) printFailure(io, envelope.error);
  }
  return envelope.ok ? 0 : 1;
}

/**
 * The gate of a destructive verb: the plan is shown, then the person is asked. With `--yes` nothing
 * is asked. Where nobody can be asked (no terminal, or `--json`) the verb is refused with its plan.
 */
export async function confirmPlan(
  io: Io,
  plan: readonly string[],
  options: { readonly yes?: boolean; readonly json?: boolean },
): Promise<void> {
  if (options.json !== true) for (const line of plan) io.err(line);
  if (options.yes === true) return;
  const refusal = (what: string): CliFailure =>
    new CliFailure(
      {
        what,
        meaning: "Nothing was changed.",
        next: "Read the plan, then run it again with --yes.",
      },
      { plan },
    );
  if (options.json === true || !io.interactive)
    throw refusal("This command changes data and nobody is at the terminal to confirm it.");
  if (!(await io.confirm("Go ahead?"))) throw refusal("You answered no.");
}

/**
 * What a spinner draws around its text: the mark and two spaces before it, three dots after it,
 * and one column kept free so that the cursor never rests past the last one.
 */
const SPINNER_COLUMNS = 7;

/**
 * A download's progress as one line of a spinner in a terminal `columns` wide. It is redrawn in
 * place, which only works while it stays on one line, so it is cut to fit: the sizes come first
 * and are the last to go.
 */
export function progressLine(
  label: string,
  done: number,
  total: number | null,
  columns: number,
): string {
  const sizes = `${size(done)}${total === null ? "" : ` of ${size(total)}`}`;
  const room = Math.max(1, columns - SPINNER_COLUMNS);
  const line = `${sizes} · ${label}`;
  return line.length <= room ? line : `${line.slice(0, room - 1)}…`;
}

/** A whole number of megabytes or kilobytes, for a line a person reads. */
export function size(bytes: number): string {
  return bytes >= 1_000_000
    ? `${Math.round(bytes / 1_000_000)} MB`
    : `${Math.ceil(bytes / 1000)} kB`;
}
