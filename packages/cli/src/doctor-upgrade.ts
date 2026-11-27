/** The checks of `ukt doctor` about change: the last upgrade, why a server will not start, and whether a harness is in use. */
import { stat } from "node:fs/promises";
import type { Finding } from "./doctor.ts";
import { readStartFailure, readUpgrade, type Home } from "./home.ts";
import { size } from "./report.ts";
import { snapshotOf } from "./upgrade.ts";
import { activity, connect } from "./server-client.ts";

/** How far back "lately" is, in days. */
const LATELY_DAYS = 7;

/** An instant to the minute, in UTC. */
const minute = (at: string): string => `${at.slice(0, 16).replace("T", " ")}Z`;

/** How long ago an instant was, in the largest whole unit. */
function ago(at: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  return minutes < 2880
    ? `${Math.round(minutes / 60)} hours ago`
    : `${Math.round(minutes / 1440)} days ago`;
}

/**
 * Why the last start of the server failed, as it kept it, as a finding that replaces "not
 * running" and its fix of starting again: the reason's own way out. Null where none was kept.
 */
export async function startFailureFinding(home: Home, detail: string): Promise<Finding | null> {
  const failure = await readStartFailure(home);
  if (failure === null) return null;
  const lines = failure.text.split("\n");
  const way = lines.find((line) => line.startsWith("Next: "))?.slice("Next: ".length);
  return {
    check: "server",
    state: "fail",
    detail: `${detail}. The last start failed (${failure.at.toISOString()}): ${lines[0] ?? ""}`,
    fix: way ?? "read the reason below, then start the server again",
    notes: lines.slice(1).filter((line) => !line.startsWith("Next: ")),
  };
}

/** What the last upgrade did, where one is on record: the copy of the store it made, and where it can be undone. */
export async function checkUpgrade(home: Home): Promise<Finding[]> {
  const check = "upgrade";
  const record = await readUpgrade(home);
  if (record === null) return [];
  const about = `${record.from} to ${record.to}, ${minute(record.at)}`;
  if (record.failed !== undefined)
    return [
      {
        check,
        state: "warn",
        detail: `${about}: the new release did not start and the earlier one was put back`,
        fix: "the reason is below; install the new release again once it is put right",
        notes: record.failed
          .split("\n")
          .filter((line) => line.trim() !== "")
          .slice(0, 6),
      },
    ];
  const snapshot = await snapshotOf(home, record);
  const copy = snapshot === null ? null : await stat(snapshot).catch(() => null);
  const store =
    snapshot === null
      ? "no migration has changed the store since"
      : copy === null
        ? `the copy of the store from before it, ${snapshot}, is gone`
        : `the store from before it: ${snapshot} (${size(copy.size)})`;
  const back = record.previous === null ? "" : `; \`ukt rollback\` returns to ${record.from}`;
  return [{ check, state: "ok", detail: `${about}; ${store}${back}` }];
}

/** Whether a harness has called this server lately: "installed" is not "in use". */
export async function checkCalls(home: Home, now = new Date()): Promise<Finding[]> {
  const check = "calls";
  try {
    const report = await activity(await connect(home), LATELY_DAYS);
    const last = report.recent[0];
    if (last === undefined)
      return [
        {
          check,
          // Not a fault: a server just installed has had no call yet. It says what "installed" does not.
          state: "ok",
          detail: `no harness has called this server in the last ${LATELY_DAYS} days: it is installed, not yet in use`,
          fix: "start a session in a connected harness; for one that is not connected, `ukt setup` or the Connect page shows how",
        },
      ];
    const sessions = report.clients.reduce((sum, client) => sum + client.sessions, 0);
    const named = report.clients.map(({ client, version }) =>
      version === null ? client : `${client} ${version}`,
    );
    return [
      {
        check,
        state: "ok",
        detail: `${[...new Set(named)].join(", ")}: last call ${ago(last.last_call_at, now)}, ${sessions} session${sessions === 1 ? "" : "s"} in ${LATELY_DAYS} days`,
      },
    ];
  } catch {
    // Why the server cannot be asked is the server's or the token's finding.
    return [];
  }
}
