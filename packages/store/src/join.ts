/**
 * Joining one project of a person's into another: what they hold in the first is the second's
 * from then on, and the first is their other name for it. It works in the person's own audience,
 * under their lock, and refuses while a group of theirs holds anything of the first, which no
 * name of one person's could bring along.
 */
import type { JoinedProject, UnitTarget } from "@uketsugi/core";
import { sql } from "kysely";
import type { Db } from "./codec.ts";

/** How many facts and tasks a person's groups hold in a project, whoever wrote them. */
export async function sharedRecords(
  db: Db,
  orgId: string,
  person: string,
  project: string,
): Promise<number> {
  const { rows } = await sql<{ records: string }>`with mine as (
      select audience_id from audience_members
      where org_id = ${orgId} and principal_id = ${person})
    select
    (select count(*) from facts
      where org_id = ${orgId} and audience_id in (select audience_id from mine)
        and project = ${project}) +
    (select count(*) from tasks
      where org_id = ${orgId} and audience_id in (select audience_id from mine)
        and project = ${project})
    as records`.execute(db);
  return Number(rows[0]?.records ?? 0);
}

/** Moves everything of `person`'s in `from` to the project `key`, which exists, and makes `from` their name for it. */
export async function joinProject(
  db: Db,
  target: UnitTarget,
  person: string,
  from: string,
  key: string,
): Promise<JoinedProject> {
  const { orgId, audienceId } = target;
  /** The rows of a table that are the person's own, in the audience the unit is open on. */
  const moved = async (table: "facts" | "tasks"): Promise<number> => {
    const done = await sql`update ${sql.table(table)} set project = ${key}
      where org_id = ${orgId} and audience_id = ${audienceId} and project = ${from}`.execute(db);
    return Number(done.numAffectedRows);
  };
  const facts = await moved("facts");
  const tasks = await moved("tasks");
  const sessions = await sql`update sessions set project = ${key}
    where org_id = ${orgId} and principal_id = ${person} and project = ${from}`.execute(db);
  // Their choice for the first stands for the second unless they have made one there. A named or
  // folder project always has one, made with it, so a shared choice never reaches one.
  await sql`with taken as (
      delete from project_choices
      where org_id = ${orgId} and principal_id = ${person} and project = ${from}
      returning org_id, principal_id, audience_id)
    insert into project_choices (org_id, principal_id, project, audience_id)
    select org_id, principal_id, ${key}, audience_id from taken
    on conflict do nothing`.execute(db);
  // Names never chain: what meant `from` means `into`, and `from` is now a name too.
  await sql`update project_names set project = ${key}
    where org_id = ${orgId} and principal_id = ${person} and project = ${from}`.execute(db);
  await sql`insert into project_names (org_id, principal_id, name, project)
    values (${orgId}, ${person}, ${from}, ${key})
    on conflict (org_id, principal_id, name) do update set project = ${key}`.execute(db);
  return { facts, tasks, sessions: Number(sessions.numAffectedRows) };
}
