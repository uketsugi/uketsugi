/**
 * Deleting a project for one person: every statement below is one structure that holds something
 * of theirs in it. The rows are deleted, not emptied, so nothing is left to say what was there.
 * What the engine's own files still hold of a deleted row, and what a backup holds, is beyond a
 * statement's reach.
 */
import type {
  AccountHoldings,
  ForgottenProject,
  ProjectHoldings,
  ReadScope,
  UnitTarget,
} from "@uketsugi/core";
import { sql } from "kysely";
import { live, scoped, type Db } from "./codec.ts";

/**
 * Deletes what a person holds in a project in the unit's own audience: its facts and tasks with
 * everything that hangs off them, what any log holds about those records, their sessions there
 * and their choice for it, and then the project's own record unless a session or a choice of
 * somebody's still names it. Returns the ids of the live facts that went, and how many facts,
 * tasks and sessions.
 */
export async function forgetProject(
  db: Db,
  target: UnitTarget,
  person: string,
  project: string,
): Promise<ForgottenProject> {
  const { orgId } = target;
  const own = { orgId, audienceIds: [target.audienceId] };
  const facts = await db
    .selectFrom("facts")
    .select(["id", sql<boolean>`${live()}`.as("live")])
    .where(scoped(own))
    .where("project", "=", project)
    .execute();
  const tasks = await db
    .selectFrom("tasks")
    .select("id")
    .where(scoped(own))
    .where("project", "=", project)
    .execute();
  await deleteRecords(db, orgId, facts, tasks);
  // Sessions, each with its note and turns, and the person's choice for the project.
  const sessions = await db
    .deleteFrom("sessions")
    .where("orgId", "=", orgId)
    .where("principalId", "=", person)
    .where("project", "=", project)
    .executeTakeFirst();
  await sql`delete from project_choices
    where org_id = ${orgId} and principal_id = ${person} and project = ${project}`.execute(db);
  // Their other names for it go too: a name needs the project it means.
  await sql`delete from project_names
    where org_id = ${orgId} and principal_id = ${person} and project = ${project}`.execute(db);
  // The project's own record, unless somebody's session or choice still names it.
  await db
    .deleteFrom("projects")
    .where("orgId", "=", orgId)
    .where("key", "=", project)
    .where(
      sql<boolean>`not exists (select 1 from sessions s where s.org_id = ${orgId} and s.project = ${project})`,
    )
    .where(
      sql<boolean>`not exists (select 1 from project_choices c where c.org_id = ${orgId} and c.project = ${project})`,
    )
    .where(
      sql<boolean>`not exists (select 1 from project_names n where n.org_id = ${orgId} and n.project = ${project})`,
    )
    .execute();
  return {
    facts: facts.length,
    tasks: tasks.length,
    sessions: Number(sessions.numDeletedRows),
  };
}

/**
 * Deletes facts and tasks by id with what hangs off them: the log's entries about them (an entry
 * stays where it was written when its record moves, so in every log), the rulings that hold a
 * fact, and the rest of a fact or a task, which goes with its row.
 */
async function deleteRecords(
  db: Db,
  orgId: string,
  facts: readonly { id: string }[],
  tasks: readonly { id: string }[],
): Promise<void> {
  const factIds = facts.map((fact) => fact.id);
  const taskIds = tasks.map((task) => task.id);
  const subjects = [...factIds, ...taskIds];
  if (subjects.length > 0) {
    await db
      .deleteFrom("events")
      .where("orgId", "=", orgId)
      .where("subject", "in", subjects)
      .execute();
  }
  if (factIds.length > 0) {
    await db
      .deleteFrom("rulings")
      .where("orgId", "=", orgId)
      .where("factId", "in", factIds)
      .execute();
    await db.deleteFrom("facts").where("orgId", "=", orgId).where("id", "in", factIds).execute();
  }
  if (taskIds.length > 0) {
    await db.deleteFrom("tasks").where("orgId", "=", orgId).where("id", "in", taskIds).execute();
  }
}

/** What a person holds in a project, and what other people hold there that the person sees. */
export async function holdingsIn(
  db: Db,
  scope: ReadScope,
  person: string,
  project: string,
): Promise<ProjectHoldings> {
  const { orgId } = scope;
  const inProject = sql`${scoped(scope)} and project = ${project}`;
  const { rows } = await sql<ProjectHoldings>`select
    (select count(*) from facts where ${inProject} and author = ${person}) as facts,
    (select count(*) from tasks where ${inProject} and publisher = ${person}) as tasks,
    (select count(*) from sessions
      where org_id = ${orgId} and principal_id = ${person} and project = ${project}) as sessions,
    (select count(*) from facts
      where ${inProject} and author <> ${person} and ${live()}) as others_facts,
    (select count(*) from tasks where ${inProject} and publisher <> ${person}) as others_tasks
  `.execute(db);
  const [held] = rows;
  if (held === undefined) throw new Error("a count of what a project holds returned no row");
  return held;
}

/** What a person wrote across every project the scope holds, and in which audience of it. */
export async function authoredIn(
  db: Db,
  scope: ReadScope,
  person: string,
): Promise<AccountHoldings> {
  const { orgId } = scope;
  const { rows } = await sql<{ audience: string; facts: string; tasks: string }>`select audience,
      sum(facts) as facts, sum(tasks) as tasks from (
        select audience_id as audience, 1 as facts, 0 as tasks from facts
          where ${scoped(scope)} and author = ${person}
        union all
        select audience_id, 0, 1 from tasks where ${scoped(scope)} and publisher = ${person}
      ) held group by audience`.execute(db);
  const byAudience = new Map(
    rows.map((row) => [row.audience, { facts: Number(row.facts), tasks: Number(row.tasks) }]),
  );
  const { rows: counts } = await sql<{
    sessions: string;
    notes: string;
    confirmations: string;
  }>`select
    (select count(*) from sessions where org_id = ${orgId} and principal_id = ${person}) as sessions,
    (select count(*) from task_notes where ${scoped(scope)} and author = ${person}) as notes,
    (select count(*) from confirmations where ${scoped(scope)} and person = ${person}) as confirmations
  `.execute(db);
  const [held] = counts;
  if (held === undefined) throw new Error("a count of what a person wrote returned no row");
  const total = (field: "facts" | "tasks") =>
    [...byAudience.values()].reduce((sum, audience) => sum + audience[field], 0);
  return {
    facts: total("facts"),
    tasks: total("tasks"),
    sessions: Number(held.sessions),
    taskNotes: Number(held.notes),
    confirmations: Number(held.confirmations),
    byAudience,
  };
}

/**
 * Deletes every fact and task a person wrote in the organization, in whichever audience it now is,
 * with what hangs off them and what any log holds about them: a record stays in the group it was
 * shared with when its author leaves the group. Returns how many facts and tasks went.
 */
export async function forgetAuthored(
  db: Db,
  orgId: string,
  person: string,
): Promise<{ facts: number; tasks: number }> {
  const { rows: facts } = await sql<{ id: string }>`select id from facts
    where org_id = ${orgId} and author = ${person}`.execute(db);
  const { rows: tasks } = await sql<{ id: string }>`select id from tasks
    where org_id = ${orgId} and publisher = ${person}`.execute(db);
  await deleteRecords(db, orgId, facts, tasks);
  return { facts: facts.length, tasks: tasks.length };
}
