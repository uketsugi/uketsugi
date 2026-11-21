/** What `ukt doctor` says of the jobs the server holds and of its embedding model, as the server tells them. */
import type { JobCounts } from "@uketsugi/core";
import type { Finding } from "./doctor.ts";

export const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The jobs the server holds: those waiting, those it gave up, and why readings wait. A reading
 * waits, or is given up, when the provider failed or refused the call (a key or an account it
 * refuses among them): its own words are kept on the session. A reading is said to wait only while
 * it does, and a job given up is told of for a day, as a warning, and after that only counted:
 * nothing clears it, and it is no news.
 */
export function jobsFinding(counts: JobCounts): Finding {
  const check = "jobs";
  const { waiting, dead, deadRecent, readingsWaiting, readingsGivenUp, lastReadingFailure } =
    counts;
  const older = dead - deadRecent;
  const held = `${waiting} waiting, ${dead} given up${older > 0 && deadRecent === 0 ? " (all more than a day ago)" : ""}`;
  const readings = [
    ...(readingsWaiting === 0
      ? []
      : [
          `${plural(readingsWaiting, "reading")} wait${readingsWaiting === 1 ? "s" : ""} because the provider failed or refused the call`,
        ]),
    ...(readingsGivenUp === 0
      ? []
      : [`${plural(readingsGivenUp, "reading")} given up in the last day for the same cause`]),
  ];
  const why =
    readings.length === 0
      ? ""
      : `; ${readings.join(", ")}: ${lastReadingFailure ?? "no reason given"}`;
  if (deadRecent === 0 && readingsWaiting === 0) return { check, state: "ok", detail: held };
  return {
    check,
    state: "warn",
    detail: `${held}${why}`,
    fix:
      readingsWaiting > 0
        ? "check the key and the account with the provider (the language model line asks it); a reading waiting on it is tried again every 30 minutes and dropped after twelve hours"
        : "a job is given up after it failed for good; the count stays until it is a day old",
  };
}

/**
 * What the server says of its own embedding model, which `checkModel` cannot see (it loads the
 * model in this process): whether the model loaded in the server, and, apart from that, the facts
 * whose embedding it gave up.
 */
export function serverModelFindings(
  start: string,
  server: { degraded: string[]; jobs: JobCounts | null },
): Finding[] {
  const restart =
    start === "ukt serve" ? "restart `ukt serve`" : start.replace(" start ", " restart ");
  const found: Finding[] = [];
  if (server.degraded.includes("embedder_unavailable"))
    found.push({
      check: "model",
      state: "warn",
      detail:
        "the server's model did not load: it failed on the first text put through it, so search matches words only",
      fix: restart,
    });
  const given = server.jobs?.deadEmbeds ?? 0;
  if (given > 0)
    found.push({
      check: "model",
      state: "warn",
      detail: `${plural(given, "fact")} could not be embedded and the server gave that up, so search matches their words only`,
      fix: `${restart}: its first pass tries them again`,
    });
  return found;
}
