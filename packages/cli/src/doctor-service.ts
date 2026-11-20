/** The service and the address checks of `ukt doctor`: how the server is kept running, and what answers where it listens. */
import { localUrl } from "@uketsugi/server";
import type { Finding } from "./doctor.ts";
import type { Home } from "./home.ts";
import { servingOf } from "./program.ts";
import type { Io } from "./report.ts";
import { whoAnswers } from "./server-client.ts";
import {
  lastWords,
  SERVICE_COMMANDS,
  serves,
  startFix,
  UNIT,
  type ServiceState,
} from "./service.ts";

/** The address this data directory's server listens on, as it is told to. */
export async function listensAt(home: Home): Promise<string> {
  const runs = await servingOf(home, {});
  return localUrl(runs.host, Number(runs.port));
}

/** Where something that is not this data directory's server answers, at the address this one would listen on; null where nothing does. */
export async function foreignAnswer(home: Home): Promise<string | null> {
  const origin = await listensAt(home);
  return (await whoAnswers(home, origin)) === "other" ? origin : null;
}

/**
 * Whether the server runs as its person's service: installed, enabled and running, with the
 * commands that stop it, start it and show what it printed. For one that is not running, the
 * cause: another program on its port, else the last lines it printed, and a fix that addresses it.
 */
export async function checkService(
  io: Io,
  env: NodeJS.ProcessEnv,
  service: ServiceState,
  home: Home,
  lingering: boolean | null,
): Promise<Finding> {
  const check = "service";
  const byHand = "the server runs while `ukt serve` does";
  if (!service.manager) return { check, state: "ok", detail: `none: ${service.why}, so ${byHand}` };
  if (service.text === null)
    return { check, state: "warn", detail: `not installed, so ${byHand}`, fix: "ukt setup" };
  if (!serves(service, home))
    return {
      check,
      state: "warn",
      detail: `${UNIT} serves another data directory, so here ${byHand}`,
      fix: "ukt setup",
    };
  const notes = [
    ...Object.entries(SERVICE_COMMANDS).map(([what, typed]) => `${what}: ${typed}`),
    ...(lingering === false
      ? ["it stops when you log out of this machine; to keep it running: loginctl enable-linger"]
      : []),
  ];
  if (!service.running) {
    const detail = `${UNIT} is installed and not running: ${service.standing}`;
    const origin = await foreignAnswer(home);
    if (origin !== null)
      return {
        check,
        state: "fail",
        detail: `${detail}. Something that is not this data directory's server answers at ${origin}, which is the service's port`,
        fix: "ukt setup --port <a free port>",
        notes,
      };
    const why = (await lastWords(io, env, home)).trim().split("\n");
    const fix = startFix(service, home);
    return { check, state: "fail", detail, fix, notes: [...notes, ...why] };
  }
  return service.enabled
    ? { check, state: "ok", detail: `${UNIT} is enabled and running`, notes }
    : {
        check,
        state: "warn",
        detail: `${UNIT} is running, but not enabled: it will not start at your next login`,
        fix: "ukt setup",
        notes,
      };
}
