import {
  isUuid,
  toHex,
  type NewTask,
  type ReadScope,
  type Task,
  type TaskChange,
  type TaskListQuery,
  type TaskNote,
  type TasksRepo,
  type TaskStep,
  type UnitTasks,
} from "@uketsugi/core";
import { sql, type Selectable } from "kysely";
import { Repo, scoped, toBytes, UnitRepo, uuidsOf, type Db } from "./codec.ts";
import { toEvent } from "./review.ts";
import type { Database } from "./schema.ts";

function tasksIn(db: Db, scope: ReadScope) {
  return db.selectFrom("tasks").selectAll().where(scoped(scope));
}

function toTask(row: Selectable<Database["tasks"]>): Task {
  const { leaseTokenHash, leaseHolder, leaseSession, leaseExpiresAt, ...task } = row;
  // `tasks_lease_whole`: the four are set together or not at all.
  const held = leaseTokenHash !== null && leaseHolder !== null && leaseSession !== null;
  const lease =
    held && leaseExpiresAt !== null
      ? {
          tokenHash: toHex(leaseTokenHash),
          holder: leaseHolder,
          session: leaseSession,
          expiresAt: leaseExpiresAt,
        }
      : null;
  return { ...task, lease };
}

async function taskIn(db: Db, scope: ReadScope, id: string): Promise<Task | null> {
  if (!isUuid(id)) return null;
  const row = await tasksIn(db, scope).where("id", "=", id).executeTakeFirst();
  return row === undefined ? null : toTask(row);
}

/** The notes of a scope, as a read returns them. */
function notesIn(db: Db, scope: ReadScope) {
  return db
    .selectFrom("taskNotes")
    .select(["orgId", "taskId", "id", "kind", "author", "session", "text", "at"])
    .where(scoped(scope));
}

/** The notes of these tasks that the scope holds; null when no id among them can be a task's, and nothing is to be asked. */
function notesAmong(db: Db, scope: ReadScope, taskIds: readonly string[]) {
  const ids = uuidsOf(taskIds);
  return ids.length === 0 ? null : notesIn(db, scope).where("taskId", "in", ids);
}

function leaseColumns(lease: Task["lease"]) {
  return {
    leaseTokenHash: lease === null ? null : toBytes(lease.tokenHash),
    leaseHolder: lease?.holder ?? null,
    leaseSession: lease?.session ?? null,
    leaseExpiresAt: lease?.expiresAt ?? null,
  };
}

/** Tasks inside a unit: scoped to the unit's organization and audience. */
export class SqlUnitTasks extends UnitRepo implements UnitTasks {
  /** An update of one task of the unit's audience. */
  private one(id: string) {
    return this.db.updateTable("tasks").where(scoped(this.scope)).where("id", "=", id);
  }

  get(id: string): Promise<Task | null> {
    return taskIn(this.db, this.scope, id);
  }

  /** The unit's tasks by one publisher in one project. */
  private by(publisher: string, project: string) {
    return tasksIn(this.db, this.scope)
      .where("publisher", "=", publisher)
      .where("project", "=", project);
  }

  async publishedBy(publisher: string, project: string): Promise<Task[]> {
    const rows = await this.by(publisher, project).execute();
    return rows.map(toTask);
  }

  async findOpenByTitle(publisher: string, project: string, title: string): Promise<Task | null> {
    const row = await this.by(publisher, project)
      .where("title", "=", title)
      .where("state", "<>", "done")
      .orderBy("createdAt")
      .executeTakeFirst();
    return row === undefined ? null : toTask(row);
  }

  async insert(task: NewTask): Promise<void> {
    const { orgId, audienceId, at } = this.target;
    const { lease } = task;
    await this.db
      .insertInto("tasks")
      .values({
        orgId,
        audienceId,
        id: task.id,
        project: task.project,
        title: task.title,
        description: task.description,
        tracked: task.tracked,
        publisher: task.publisher,
        state: lease === null ? "open" : "claimed",
        version: 1,
        ...leaseColumns(lease),
        createdAt: at,
        updatedAt: at,
      })
      .execute();
  }

  async change(id: string, version: number, change: TaskChange): Promise<Task | null> {
    if (!isUuid(id)) return null;
    let update = this.one(id).set({ version: version + 1, updatedAt: this.target.at });
    if (change.state !== undefined) update = update.set({ state: change.state });
    if (change.lease !== undefined) update = update.set(leaseColumns(change.lease));
    const row = await update.where("version", "=", version).returningAll().executeTakeFirst();
    return row === undefined ? null : toTask(row);
  }

  async renew(id: string, expiresAt: Date): Promise<Task | null> {
    if (!isUuid(id)) return null;
    const row = await this.one(id)
      .set({ leaseExpiresAt: expiresAt })
      .where("leaseTokenHash", "is not", null)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toTask(row);
  }

  async addNote(note: Omit<TaskNote, "orgId" | "at">): Promise<void> {
    const { orgId, audienceId, at } = this.target;
    const { taskId, id, kind, author, session, text } = note;
    await this.db
      .insertInto("taskNotes")
      .values({ orgId, audienceId, taskId, id, kind, author, session, text, at })
      .execute();
  }

  async lastNote(taskId: string): Promise<TaskNote | null> {
    if (!isUuid(taskId)) return null;
    const row = await notesIn(this.db, this.scope)
      .where("taskId", "=", taskId)
      .orderBy("at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    return row ?? null;
  }
}

/** Tasks outside a unit: every read is scoped by organization and visible audiences. */
export class SqlTasks extends Repo implements TasksRepo {
  /** The tasks a listing matches, before it is ordered, cut or counted. */
  private matching(scope: ReadScope, query: Omit<TaskListQuery, "limit">) {
    let rows = this.db.selectFrom("tasks").where(scoped(scope));
    const { project, person } = query;
    if (project !== undefined) rows = rows.where("project", "=", project);
    if (query.states !== undefined && query.states.length > 0)
      rows = rows.where("state", "in", [...query.states]);
    if (person !== undefined) {
      rows = rows.where((eb) =>
        eb.or([eb("publisher", "=", person), eb("leaseHolder", "=", person)]),
      );
    }
    return rows;
  }

  get(scope: ReadScope, id: string): Promise<Task | null> {
    return taskIn(this.db, scope, id);
  }

  async list(scope: ReadScope, query: TaskListQuery): Promise<Task[]> {
    const rows = await this.matching(scope, query)
      .selectAll()
      .orderBy("updatedAt", "desc")
      .orderBy("id", "desc")
      .limit(query.limit)
      .execute();
    return rows.map(toTask);
  }

  async count(scope: ReadScope, query: Omit<TaskListQuery, "limit">): Promise<number> {
    const row = await this.matching(scope, query)
      .select((eb) => eb.fn.countAll<number>().as("tasks"))
      .executeTakeFirstOrThrow();
    return row.tasks;
  }

  async notes(scope: ReadScope, taskIds: readonly string[]): Promise<TaskNote[]> {
    const oldestFirst = notesAmong(this.db, scope, taskIds)?.orderBy("at").orderBy("id");
    return (await oldestFirst?.execute()) ?? [];
  }

  notesBy(scope: ReadScope, person: string): Promise<TaskNote[]> {
    return notesIn(this.db, scope)
      .where("author", "=", person)
      .orderBy("at")
      .orderBy("id")
      .execute();
  }

  async latestNotes(scope: ReadScope, taskIds: readonly string[]): Promise<TaskNote[]> {
    const newestOfEach = notesAmong(this.db, scope, taskIds)
      ?.distinctOn("taskId")
      .orderBy("taskId");
    return (await newestOfEach?.orderBy("at", "desc").orderBy("id", "desc").execute()) ?? [];
  }

  async history(scope: ReadScope, taskId: string): Promise<TaskStep[]> {
    if (!isUuid(taskId)) return [];
    const rows = await this.db
      .selectFrom("events")
      .selectAll()
      .where(scoped(scope))
      .where("subject", "=", taskId)
      .where(sql<boolean>`kind like 'Task%'`)
      .orderBy("at")
      .orderBy("seq")
      .execute();
    return rows.map(toEvent);
  }
}
