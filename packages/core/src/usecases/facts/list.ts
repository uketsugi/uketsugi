/**
 * Facts as the dashboard reads them: a list, newest first and paged; a search in one project; and
 * one fact with its confirmations and what the log holds about it. Every read takes the person's
 * visible set. A redacted fact is listed as a stub, so that the person sees it was there.
 */
import type { FactDetail, FactHistoryEntry, FactListParams, FactPage } from "@uketsugi/contracts";
import { idOf, nameOf, namesFor, scopeOf } from "../../context.ts";
import type { Actor, Caller } from "../../domain.ts";
import { apiFacts } from "../../facts/views.ts";
import { invalidInput, notFound } from "../../failure.ts";
import type { CorePorts } from "../../ports.ts";
import { parseProject, projectFilter } from "../../project.ts";
import { privateBecause } from "../../sharing.ts";
import { rankFacts } from "./search.ts";

/** How many of a fact's events its history shows. */
const HISTORY_LIMIT = 100;
const CURSOR = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)~([0-9a-f-]{36})$/;

/** The position a cursor names: the last fact of the page before. */
function positionOf(cursor: string | undefined): { updatedAt: Date; id: string } | undefined {
  if (cursor === undefined || cursor === "") return undefined;
  const [, at, id] = CURSOR.exec(cursor) ?? [];
  const updatedAt = new Date(at ?? "");
  if (id === undefined || Number.isNaN(updatedAt.getTime())) {
    throw invalidInput("The cursor is not one this server gave.", "Start again without a cursor.");
  }
  return { updatedAt, id };
}

/**
 * A search from the dashboard runs the agents' own ranking in the named project, so the person
 * sees what an agent would. It is nobody's session: nothing is stamped and nothing is counted.
 */
async function searchPage(
  ports: CorePorts,
  caller: Caller,
  params: FactListParams,
  q: string,
): Promise<FactPage> {
  const ref = parseProject(params.project);
  if (ref === null) {
    throw invalidInput("A search needs a project.", "Choose the project to search in.");
  }
  const project = await ports.store.projects.find(caller.orgId, ref.key);
  if (project === null) return { facts: [], next: null, matched: 0 };
  const found = await rankFacts(ports, { caller, project }, q, params.limit);
  return { facts: await apiFacts(ports, caller, found.facts), next: null, matched: found.matched };
}

/** A page of facts, newest first; with `q`, the matches of a search in one project. */
export async function listFacts(
  ports: CorePorts,
  caller: Caller,
  params: FactListParams,
): Promise<FactPage> {
  const q = params.q?.trim() ?? "";
  if (q !== "") return searchPage(ports, caller, params, q);
  const { limit } = params;
  const rows = await ports.store.facts.list(scopeOf(caller), {
    project: projectFilter(params.project, "facts"),
    before: positionOf(params.cursor),
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const more = rows.length > limit && last !== undefined;
  return {
    facts: await apiFacts(ports, caller, page),
    next: more ? `${last.updatedAt.toISOString()}~${last.id}` : null,
  };
}

/** One fact with its confirmations and its history, newest first. */
export async function factDetail(
  ports: Pick<CorePorts, "store">,
  caller: Caller,
  id: string,
): Promise<FactDetail> {
  const scope = scopeOf(caller);
  const { facts, review } = ports.store;
  const fact = await facts.get(scope, idOf(id));
  if (fact === null) throw notFound("listed fact", id);
  const [confirmations, events, [view]] = await Promise.all([
    review.confirmations(scope, [fact.id]),
    review.history(scope, fact.id, HISTORY_LIMIT),
    apiFacts(ports, caller, [fact]),
  ]);
  if (view === undefined) throw notFound("listed fact", id);
  const people = (actor: Actor) => (actor.kind === "person" ? [actor.id] : []);
  // A move is written in the log it leaves and in the log it joins: its author reads both, once.
  const shown = events.filter((event) => !("left" in event.payload && event.payload.left));
  const names = await namesFor(ports, caller, [
    ...confirmations.map((entry) => entry.person),
    ...shown.flatMap((event) => people(event.actor)),
  ]);
  const because = await privateBecause(ports, caller, fact);
  return {
    fact: view,
    ...(because === null ? {} : { private_because: because }),
    confirmations: confirmations
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .map((entry) => ({
        person: nameOf(names, entry.person),
        by_author: entry.person === fact.author,
        at: entry.at.toISOString(),
        checked: entry.checked,
        source_version: entry.sourceVersion,
      })),
    history: shown.map((event): FactHistoryEntry => ({
      kind: event.kind,
      actor: event.actor.kind === "person" ? nameOf(names, event.actor.id) : event.actor.job,
      at: event.at.toISOString(),
    })),
  };
}
