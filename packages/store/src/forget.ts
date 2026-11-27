/**
 * Deleting a project for one person: every statement below is one structure that holds something
 * of theirs in it. The rows are deleted, not emptied, so nothing is left to say what was there.
 * What the engine's own files still hold of a deleted row, and what a backup holds, is beyond a
 * statement's reach.
 */
import type { ForgottenProject, ProjectHoldings, ReadScope, UnitTarget } from "@uketsugi/core";
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
  const factIds = facts.map((fact) => fact.id);
  const taskIds = tasks.map((task) => task.id);

  // The log: an entry stays where it was written when its record moves, so in every log.
  const subjects = [...factIds, ...taskIds];
  if (subjects.length > 0) {
    await db
      .deleteFrom("events")
      .where("orgId", "=", orgId)
      .where("subject", "in", subjects)
      .execute();
  }
  if (factIds.length > 0) {
    // Rulings hold their fact; the rest of a fact goes with its row: identifiers, cited facts,
    // confirmations, flags and jobs are deleted by the key that names it.
    await db.deleteFrom("rulings").where(scoped(own)).where("factId", "in", factIds).execute();
    await db.deleteFrom("facts").where(scoped(own)).where("id", "in", factIds).execute();
  }
  // A task's notes go with it.
  if (taskIds.length > 0) {
    await db.deleteFrom("tasks").where(scoped(own)).where("id", "in", taskIds).execute();
  }
  // Sessions, each with its note and turns, and the person's choice for the project.
  const sessions = await db
    .deleteFrom("sessions")
    .where("orgId", "=", orgId)
    .where("principalId", "=", person)
    .where("project", "=", project)
    .executeTakeFirst();
  await sql`delete from project_choices
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
    .execute();
  return {
    facts: factIds.length,
    tasks: taskIds.length,
    sessions: Number(sessions.numDeletedRows),
  };
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
