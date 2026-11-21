/**
 * The guard on the owner's allowance. Claude Code reports the seven-day window's utilisation in
 * `rate_limit_event` lines of a transcript, only once it is past 0.75. A run reads the newest
 * reading before its first session (from the transcripts of the run before it), lowers the number of
 * units so that the reading and the run's projection stay under 0.90, and starts no session once a
 * later reading reaches 0.90 or shows overage (his money). The reading is
 * `handoff/lanes/done/conversion/drive_block.py` `latest_use`, ported.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const STOP_AT = 0.9;
/** A reading older than this says too little of the window now: a run refuses it. */
export const MAX_READING_AGE_MS = 2 * 60 * 60 * 1000;
/** What one unit is expected to use of the window: about 38 M Haiku tokens, 1.5 points. */
export const UNIT_POINTS = 0.015;

export interface Reading {
  /** The seven-day window's utilisation, 0 to 1. */
  readonly utilization: number;
  /** Whether the window is allowed and not in overage. */
  readonly ok: boolean;
}

/** The newest reading in a transcript, ignoring a window that has reset (it says nothing of the new one), or undefined. */
export function readingOf(transcript: string, nowSeconds: number): Reading | undefined {
  let best: Reading | undefined;
  for (const line of transcript.split("\n")) {
    if (!line.includes('"rate_limit_event"')) continue;
    try {
      const info = (JSON.parse(line) as { rate_limit_info: Record<string, unknown> })
        .rate_limit_info;
      if (typeof info["resetsAt"] === "number" && info["resetsAt"] < nowSeconds) continue;
      best = {
        utilization: Number(info["utilization"] ?? 0),
        ok:
          info["isUsingOverage"] !== true &&
          (info["status"] === "allowed" || info["status"] === "allowed_warning"),
      };
    } catch {
      // not an event
    }
  }
  return best;
}

/** The most units a run may start: `wanted`, lowered so that the reading plus 1.5 points a unit stays under 0.90. */
export function lowerUnits(wanted: number, reading: Reading): number {
  if (!reading.ok || reading.utilization >= STOP_AT) return 0;
  const room = Math.ceil((STOP_AT - reading.utilization) / UNIT_POINTS - 1e-9) - 1;
  return Math.max(0, Math.min(wanted, room));
}

export class Guard {
  private latest: Reading;

  constructor(first: Reading | undefined) {
    if (first === undefined)
      throw new Error(
        "no reading of the seven-day window, or the newest is over 2 hours old: point the run at the kept transcripts of a calibration, a harness-memory check or an earlier run made in the last 2 hours (--reading-from <its folder>), which hold a rate-limit event",
      );
    this.latest = first;
  }

  /** Takes the newest reading of a finished session's transcript, if it has one. */
  observe(transcript: string, nowSeconds: number): void {
    this.latest = readingOf(transcript, nowSeconds) ?? this.latest;
  }

  /** Whether a session may start now: the newest reading is under 0.90 and not in overage. */
  mayStart(): boolean {
    return this.latest.ok && this.latest.utilization < STOP_AT;
  }
}

/** The newest reading in the transcripts a run kept (under its `cases` folder): where the next run's first reading comes from. */
export async function readingFromRun(
  folder: string,
  now = Date.now(),
): Promise<Reading | undefined> {
  const cases = join(folder, "cases");
  const files: { path: string; time: number }[] = [];
  for (const name of await readdir(cases, { recursive: true }).catch(() => [])) {
    if (!/(^|\/)transcripts\/[^/]+\.jsonl$/.test(name)) continue;
    files.push({ path: join(cases, name), time: (await stat(join(cases, name))).mtimeMs });
  }
  let best: Reading | undefined;
  let at = 0;
  for (const file of files.sort((a, b) => a.time - b.time)) {
    const found = readingOf(await readFile(file.path, "utf8"), now / 1000);
    if (found !== undefined) {
      best = found;
      at = file.time;
    }
  }
  return best !== undefined && now - at <= MAX_READING_AGE_MS ? best : undefined;
}
