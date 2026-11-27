import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "kysely";
import type { Move, Store, Unit, UnitTarget, UnitWrites } from "@uketsugi/core";
import { behindOf } from "./chain.ts";
import { actorColumns, scoped, uuidsOf, type Db } from "./codec.ts";
import { groupIdsOf } from "./audiences.ts";
import { SqlDirectory } from "./directory.ts";
import { SqlProjects } from "./projects.ts";
import { SqlFacts, SqlUnitFacts } from "./facts.ts";
import { forgetProject } from "./forget.ts";
import { joinProject, sharedRecords } from "./join.ts";
import { SqlJobs } from "./jobs.ts";
import { SqlReview, SqlUnitReview } from "./review.ts";
import { SqlSearch } from "./search.ts";
import { SqlSessions } from "./sessions.ts";
import { SqlTasks, SqlUnitTasks } from "./tasks.ts";

/**
 * The head rows a unit holds: its own audience's first, and the groups' once it has reached them,
 * in the order of the groups' ids: a unit that asks for one out of that order is refused, so that
 * no two units wait for each other. A head row is its audience's write lock and the sequence of
 * its log.
 */
class Heads {
  private readonly trx: Db;
  private readonly orgId: string;
  private readonly held = new Map<string, { stored: number; last: number }>();

  constructor(trx: Db, orgId: string) {
    this.trx = trx;
    this.orgId = orgId;
  }

  private head(audienceId: string) {
    return this.trx
      .selectFrom("audienceHead")
      .where("orgId", "=", this.orgId)
      .where("audienceId", "=", audienceId);
  }

  /** Locks an audience's head: a second unit that wants it waits here until this one ends. */
  async lock(audienceId: string): Promise<void> {
    if (this.held.has(audienceId)) return;
    const last = [...this.held.keys()].slice(1).at(-1);
    if (last !== undefined && audienceId < last)
      throw new Error("a unit takes the heads of groups in the order of their ids");
    const head = await this.head(audienceId).select("lastSeq").forUpdate().executeTakeFirst();
    if (head === undefined) throw new Error("a unit was opened on an audience that does not exist");
    this.held.set(audienceId, { stored: head.lastSeq, last: head.lastSeq });
  }

  /** Whether the unit holds an audience's head. */
  holds(audienceId: string): boolean {
    return this.held.has(audienceId);
  }

  /** The next sequence of a log this unit holds. */
  next(audienceId: string): number {
    const head = this.held.get(audienceId);
    if (head === undefined) throw new Error("a unit appends only to a log whose head it holds");
    head.last += 1;
    return head.last;
  }

  /** Advances every head the unit appended under. */
  async save(): Promise<void> {
    for (const [audienceId, head] of this.held) {
      if (head.last === head.stored) continue;
      await this.trx
        .updateTable("audienceHead")
        .set({ lastSeq: head.last })
        .where("orgId", "=", this.orgId)
        .where("audienceId", "=", audienceId)
        .execute();
    }
  }
}

/**
 * Moves records from one audience to another. Each statement changes the audience of the rows
 * themselves; what hangs off them follows by its key (`ON UPDATE CASCADE`), and a chain moves
 * whole, so a fact and the facts it replaced never part.
 */
async function moveRecords(
  trx: Db,
  orgId: string,
  move: Move,
): Promise<{ facts: string[]; tasks: string[] }> {
  const from = { orgId, audienceIds: [move.from] };
  const facts = (await behindOf(trx, from, move.facts)).map((fact) => fact.id);
  if (facts.length > 0) {
    await trx
      .updateTable("facts")
      .set({ audienceId: move.to })
      .where(scoped(from))
      .where("id", "in", facts)
      .execute();
  }
  const wanted = uuidsOf(move.tasks);
  if (wanted.length === 0) return { facts, tasks: [] };
  const tasks = await trx
    .updateTable("tasks")
    .set({ audienceId: move.to })
    .where(scoped(from))
    .where("id", "in", wanted)
    .returning("id")
    .execute();
  return { facts, tasks: tasks.map((task) => task.id) };
}

/** What a unit writes in one audience whose head it holds. */
function writesOn(trx: Db, target: UnitTarget, heads: Heads): UnitWrites {
  const { orgId, audienceId, at } = target;
  return {
    audienceId,
    facts: new SqlUnitFacts(trx, target),
    review: new SqlUnitReview(trx, target),
    tasks: new SqlUnitTasks(trx, target),
    async append(event) {
      const seq = heads.next(audienceId);
      const by = actorColumns(event.actor);
      await trx
        .insertInto("events")
        .values({
          orgId,
          audienceId,
          seq,
          at,
          kind: event.kind,
          subject: event.subject,
          session: event.session,
          actorPerson: by.person,
          actorJob: by.job,
          payload: JSON.stringify(event.payload),
        })
        .execute();
      return seq;
    },
    async enqueue(job) {
      const { id, kind, subject, runAfter } = job;
      await trx
        .insertInto("outbox")
        .values({ orgId, audienceId, id, kind, subject, runAfter })
        .execute();
    },
  };
}

const PERSONS_ONLY =
  "only a unit opened on a person's own audience reads their choice or reaches a group";

/** A unit reaches only the groups its person is a member of: a write racing a removal does not land in one. */
async function requireMember(
  trx: Db,
  orgId: string,
  groupId: string,
  person: string,
): Promise<void> {
  const { rows } = await sql`select 1 from audience_members
    where org_id = ${orgId} and audience_id = ${groupId} and principal_id = ${person}`.execute(trx);
  if (rows.length === 0)
    throw new Error("a unit reaches only the groups its person is a member of");
}

/** A unit over an open transaction that holds the head of the audience it was opened on. */
function unitOver(trx: Db, target: UnitTarget, heads: Heads): Unit {
  const { orgId, audienceId } = target;
  const audiences = () => trx.selectFrom("audiences").where("orgId", "=", orgId);
  const choices = new SqlProjects(trx);
  let asked: Promise<string> | undefined;
  /** The person whose own audience the unit is open on: their head row is the lock it holds. */
  const person = (): Promise<string> => {
    asked ??= audiences()
      .select("ownerId")
      .where("id", "=", audienceId)
      .where("kind", "=", "private")
      .executeTakeFirst()
      .then((own) => {
        if (own === undefined || own.ownerId === null) throw new Error(PERSONS_ONLY);
        return own.ownerId;
      });
    return asked;
  };
  const unit: Unit = {
    ...writesOn(trx, target, heads),
    async on(groupId) {
      if (!heads.holds(groupId)) {
        const owner = await person();
        const group = await audiences()
          .select("id")
          .where("id", "=", groupId)
          .where("kind", "=", "group")
          .executeTakeFirst();
        if (group === undefined)
          throw new Error("a unit reaches no audience but its organization's groups");
        await heads.lock(groupId);
        // Read once the head is held: a removal takes the head too, so it is either done by now, and
        // seen here, or waits for this unit.
        await requireMember(trx, orgId, groupId, owner);
      }
      return writesOn(trx, { ...target, audienceId: groupId }, heads);
    },
    async audienceOf(kind, id) {
      const [wanted] = uuidsOf([id]);
      if (wanted === undefined) return null;
      const owner = await person();
      const table = sql.table(kind === "fact" ? "facts" : "tasks");
      const { rows } = await sql<{ audienceId: string }>`select audience_id as "audienceId"
        from ${table} where org_id = ${orgId} and id = ${wanted}
        and (audience_id = ${audienceId} or audience_id in (
          select audience_id from audience_members
          where org_id = ${orgId} and principal_id = ${owner}))`.execute(trx);
      return rows[0]?.audienceId ?? null;
    },
    choice: async (project) => choices.choice(orgId, await person(), project),
    choose: async (project, groupId) => choices.choose(orgId, await person(), project, groupId),
    async forgetProject(project) {
      return forgetProject(trx, target, await person(), project);
    },
    async move(move) {
      const other = move.from === audienceId ? move.to : move.from;
      if (other === audienceId || (move.from !== audienceId && move.to !== audienceId))
        throw new Error("a move runs between the unit's audience and one other audience");
      if (!heads.holds(other))
        throw new Error("a move runs to or from a group the unit has reached");
      return moveRecords(trx, orgId, move);
    },
    async joinProject(from, into) {
      const owner = await person();
      // The person's groups, their heads taken in order: nothing is written into them meanwhile.
      const groups = await groupIdsOf(trx, orgId, owner);
      for (const group of groups) await unit.on(group);
      const records = await sharedRecords(trx, orgId, owner, from);
      if (records > 0) return { shared: records };
      return joinProject(trx, target, owner, from, into);
    },
  };
  return unit;
}

/** Marks the code a unit's callback runs, and whatever it awaits, until the callback settles. */
type UnitMark = AsyncLocalStorage<{ open: boolean }>;

function refuseInsideUnit(mark: UnitMark, call: string): void {
  if (mark.getStore()?.open !== true) return;
  throw new Error(
    `${call} was called from inside a unit. Inside a unit only the unit itself may be used: ` +
      "read and write through the callback's argument, and call the store before or after it.",
  );
}

/**
 * A repository that refuses to run inside a unit. The embedded engine has one connection and the
 * unit holds it: a call around the unit would wait for the unit, and the unit for the call. On a
 * server the call would run, but outside the unit's transaction. Either way it is a mistake.
 */
function outsideUnits<T extends object>(mark: UnitMark, name: string, repo: T): T {
  return new Proxy(repo, {
    get(target, key, receiver) {
      const member: unknown = Reflect.get(target, key, receiver);
      if (typeof member !== "function") return member;
      return async (...args: unknown[]): Promise<unknown> => {
        refuseInsideUnit(mark, `store.${name}.${String(key)}`);
        return (member as (...args: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/**
 * The Store over a PostgreSQL connection, embedded or on a server: the statements are the same.
 * `close` releases whatever the opener holds (the engine, a pool, a data-directory lock).
 */
export function createStore(db: Db, close: () => Promise<void>): Store {
  const mark: UnitMark = new AsyncLocalStorage();
  return {
    async unit(target, fn) {
      refuseInsideUnit(mark, "store.unit");
      return db.transaction().execute(async (trx) => {
        const heads = new Heads(trx, target.orgId);
        await heads.lock(target.audienceId);
        const state = { open: true };
        const result = await mark
          .run(state, async () => fn(unitOver(trx, target, heads)))
          .finally(() => {
            state.open = false;
          });
        await heads.save();
        return result;
      });
    },
    facts: outsideUnits(mark, "facts", new SqlFacts(db)),
    search: outsideUnits(mark, "search", new SqlSearch(db)),
    review: outsideUnits(mark, "review", new SqlReview(db)),
    tasks: outsideUnits(mark, "tasks", new SqlTasks(db)),
    jobs: outsideUnits(mark, "jobs", new SqlJobs(db)),
    sessions: outsideUnits(mark, "sessions", new SqlSessions(db)),
    projects: outsideUnits(mark, "projects", new SqlProjects(db)),
    directory: outsideUnits(mark, "directory", new SqlDirectory(db)),
    close,
  };
}
