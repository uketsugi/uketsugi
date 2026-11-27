/**
 * What a session's brief is composed from, read from the store for one reader: the project's
 * tasks, how the person's last session there ended and what it left, and the project's standing
 * facts in the order a brief lists them.
 *
 * Which facts come first is a rule's choice: how each stands, then how lately it changed. Where a
 * model read the person's last session here and chose, its choice leads and the rule orders the
 * rest. What the person told an agent leads the brief's facts whatever its age: a fact cited only
 * to the person (every citation a person's word) is read apart from the newest, and the brief
 * composes it first within its share.
 */
import type { BriefFact, Fact as FactView } from "@uketsugi/contracts";
import { CITES_PERSON, composeBrief, type BriefSources, type ComposedBrief } from "./brief.ts";
import { scopeOf, type CallContext } from "./context.ts";
import type { Fact, ReadScope } from "./domain.ts";
import { citesPerson } from "./facts/citations.ts";
import { isLive, type LiveFact } from "./facts/duplicates.ts";
import { factViews } from "./facts/views.ts";
import type { CorePorts } from "./ports.ts";
import { SEARCH_PROFILE } from "./search/fusion.ts";
import { factStanding, standingWeight } from "./search/standing.ts";
import { viewerOf } from "./usecases/tasks/shared.ts";

/** How many of a project's facts are read to choose from, newest first. */
const FACT_POOL = 60;

/** How many facts cited only to the person are read, newest first: more than their share holds. */
const TOLD_POOL = 20;

/** A fact as a brief lists it; `cited` holds the ids of the facts that cite the person. */
function briefFact(view: FactView, cited: ReadonlySet<string>): BriefFact {
  const from = view.from_session === undefined ? {} : { from_session: view.from_session };
  const cites = cited.has(view.id) ? ({ cites: CITES_PERSON } as const) : {};
  return { id: view.id, claim: view.claim, trust: view.trust, ...from, ...cites };
}

/**
 * The project's standing facts, most relevant first for a session that has asked nothing yet. Each
 * is weighed as a search weighs a match's standing: by who vouches for it, whether it is doubted
 * and how lately it was written or checked. Equal weights go to the most recently changed.
 */
function byStanding(
  facts: readonly Fact[],
  views: readonly FactView[],
  reader: string,
  now: Date,
): FactView[] {
  const weights = new Map<string, number>();
  for (const view of views) {
    const fact = facts.find((entry) => entry.id === view.id);
    if (fact === undefined) continue;
    const row = {
      status: fact.status,
      author: fact.author,
      flagged: view.flags.length > 0,
      updatedAt: fact.updatedAt,
      confirmedAt: view.confirmed_at === undefined ? null : new Date(view.confirmed_at),
    };
    weights.set(view.id, standingWeight(factStanding(row, reader, now, SEARCH_PROFILE)));
  }
  const weight = (view: FactView): number => weights.get(view.id) ?? 0;
  return [...views].sort(
    (a, b) => weight(b) - weight(a) || b.updated_at.localeCompare(a.updated_at),
  );
}

/** The facts with those a model chose for this brief first, in the order it chose them. */
function chosenFirst(ordered: readonly FactView[], picks: readonly string[]): FactView[] {
  const chosen = picks.flatMap((id) => ordered.filter((view) => view.id === id));
  return [...chosen, ...ordered.filter((view) => !picks.includes(view.id))];
}

/**
 * The live facts a brief orders: the project's newest, and any a model chose for this brief that
 * are older than those.
 */
async function standingFacts(
  ports: Pick<CorePorts, "store">,
  scope: ReadScope,
  project: string,
  picks: readonly string[],
): Promise<LiveFact[]> {
  const { facts } = ports.store;
  const newest = (await facts.list(scope, { project, limit: FACT_POOL })).filter(isLive);
  const older = picks.filter((id) => !newest.some((fact) => fact.id === id));
  const chosen = older.length === 0 ? [] : await facts.getMany(scope, older);
  return [...newest, ...chosen.filter(isLive).filter((fact) => fact.project === project)];
}

/** The standing facts and, after them, the told ones among them not already there. */
function withTold(standing: readonly LiveFact[], told: readonly LiveFact[]): LiveFact[] {
  return [...standing, ...told.filter((fact) => !standing.some((other) => other.id === fact.id))];
}

/** The newest live facts of the project that only the person has vouched for. */
function toldFacts(
  ports: Pick<CorePorts, "store">,
  scope: ReadScope,
  project: string,
): Promise<LiveFact[]> {
  return ports.store.facts
    .list(scope, { project, citedOnlyToPerson: true, limit: TOLD_POOL })
    .then((found) => found.filter(isLive));
}

/**
 * Reads what a brief is composed from, for the session of a call. `notice` is what the person has
 * yet to decide about the project, if anything.
 */
export async function briefSources(
  ports: Pick<CorePorts, "store" | "clock">,
  ctx: Pick<CallContext, "caller" | "project" | "session">,
  notice: string | null,
): Promise<BriefSources> {
  const { store } = ports;
  const { caller, session } = ctx;
  const project = ctx.project.key;
  const scope = scopeOf(caller);
  const now = ports.clock.now();
  const [tasks, factCount, previous, picks] = await Promise.all([
    store.tasks.list(scope, { project, states: ["open", "claimed", "handed_off"], limit: 50 }),
    store.facts.count(scope, project),
    store.sessions.previous(caller.orgId, caller.principalId, project, session.id),
    store.sessions.picks(caller.orgId, caller.principalId, project),
  ]);
  const [standing, told] = await Promise.all([
    standingFacts(ports, scope, project, picks),
    toldFacts(ports, scope, project),
  ]);
  const cited = new Set(
    withTold(standing, told)
      .filter(citesPerson)
      .map((fact) => fact.id),
  );
  const taskIds = tasks.map((task) => task.id);
  const [views, notes, during] = await Promise.all([
    factViews(ports, caller, withTold(standing, told)),
    store.tasks.latestNotes(scope, taskIds),
    previous === null ? ([] as string[]) : store.review.publishedIn(scope, previous.id),
  ]);
  const viewer = await viewerOf(ports, ctx, now, { tasks, notes });
  const left = views.filter((view) => during.includes(view.id));
  const isStanding = (view: FactView): boolean => standing.some((fact) => fact.id === view.id);
  const viewOf = (fact: LiveFact): FactView[] => views.filter((view) => view.id === fact.id);
  const byModel = (view: FactView): boolean => view.from_session !== undefined;
  /** Every fact the brief lists, in whichever part of it, is marked by the one set of facts that cite the person. */
  const listed = (view: FactView): BriefFact => briefFact(view, cited);
  return {
    ...viewer,
    project,
    notice,
    person: caller.principalId,
    tasks,
    notes,
    previous:
      previous === null
        ? null
        : {
            session: previous,
            published: left.filter((view) => !byModel(view)).map(listed),
            digested: left.filter(byModel).map(listed),
          },
    facts: chosenFirst(
      byStanding(standing, views.filter(isStanding), caller.principalId, now),
      picks,
    ).map(listed),
    told: told.flatMap(viewOf).map(listed),
    factCount,
  };
}

/** The brief of the session of a call, read and composed. */
export async function sessionBrief(
  ports: Pick<CorePorts, "store" | "clock">,
  ctx: Pick<CallContext, "caller" | "project" | "session">,
  notice: string | null,
): Promise<ComposedBrief> {
  return composeBrief(await briefSources(ports, ctx, notice));
}
