import type {
  AccountHoldings,
  Choice,
  PersonProject,
  Project,
  ProjectHoldings,
  ProjectRef,
  ProjectsRepo,
  ReadScope,
} from "@uketsugi/core";
import { authoredIn, holdingsIn } from "./forget.ts";
import { inByteOrder, Repo } from "./codec.ts";
import { didSomething } from "./sessions.ts";

/** An organization's projects, each known by its key, and each person's choice for theirs. */
export class SqlProjects extends Repo implements ProjectsRepo {
  holdings(scope: ReadScope, person: string, project: string): Promise<ProjectHoldings> {
    return holdingsIn(this.db, scope, person, project);
  }

  authored(scope: ReadScope, person: string): Promise<AccountHoldings> {
    return authoredIn(this.db, scope, person);
  }

  private of(orgId: string) {
    return this.db
      .selectFrom("projects")
      .select(["orgId", "key", "kind"])
      .where("orgId", "=", orgId);
  }

  async find(orgId: string, key: string): Promise<Project | null> {
    return (await this.of(orgId).where("key", "=", key).executeTakeFirst()) ?? null;
  }

  async ensure(orgId: string, ref: ProjectRef): Promise<Project> {
    const known = await this.find(orgId, ref.key);
    if (known !== null) return known;
    await this.db
      .insertInto("projects")
      .values({ orgId, key: ref.key, kind: ref.kind })
      .onConflict((conflict) => conflict.columns(["orgId", "key"]).doNothing())
      .execute();
    const stored = await this.find(orgId, ref.key);
    if (stored === null) throw new Error(`the project ${ref.key} could not be created`);
    return stored;
  }

  async listOf(orgId: string, principalId: string): Promise<PersonProject[]> {
    const rows = await this.db
      .selectFrom("projects as p")
      .leftJoin("projectChoices as c", (join) =>
        join
          .onRef("c.orgId", "=", "p.orgId")
          .onRef("c.project", "=", "p.key")
          .on("c.principalId", "=", principalId),
      )
      .select(["p.orgId", "p.key", "p.kind"])
      .select(["c.principalId as chosenBy", "c.audienceId", "c.displayName"])
      .where("p.orgId", "=", orgId)
      .where((eb) =>
        eb.or([
          eb("c.principalId", "is not", null),
          eb.exists(
            eb
              .selectFrom("sessions as s")
              .select("s.id")
              .whereRef("s.orgId", "=", "p.orgId")
              .whereRef("s.project", "=", "p.key")
              .where("s.principalId", "=", principalId)
              .where(didSomething("s")),
          ),
        ]),
      )
      .orderBy(inByteOrder("p.key"))
      .execute();
    return rows.map(({ chosenBy, audienceId, ...project }) => ({
      ...project,
      choice: chosenBy === null ? null : { groupId: audienceId },
    }));
  }

  async nameFor(orgId: string, principalId: string, name: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("projectNames")
      .select("project")
      .where("orgId", "=", orgId)
      .where("principalId", "=", principalId)
      .where("name", "=", name)
      .executeTakeFirst();
    return row?.project ?? null;
  }

  async otherNames(orgId: string, principalId: string): Promise<Map<string, string[]>> {
    const rows = await this.db
      .selectFrom("projectNames")
      .select(["project", "name"])
      .where("orgId", "=", orgId)
      .where("principalId", "=", principalId)
      .orderBy(inByteOrder("name"))
      .execute();
    const names = new Map<string, string[]>();
    for (const { project, name } of rows) names.set(project, [...(names.get(project) ?? []), name]);
    return names;
  }

  async choice(orgId: string, principalId: string, project: string): Promise<Choice | null> {
    const row = await this.db
      .selectFrom("projectChoices")
      .select("audienceId")
      .where("orgId", "=", orgId)
      .where("principalId", "=", principalId)
      .where("project", "=", project)
      .executeTakeFirst();
    return row === undefined ? null : { groupId: row.audienceId };
  }

  async choose(
    orgId: string,
    principalId: string,
    project: string,
    group: string | null,
    displayName?: string,
  ): Promise<void> {
    const named = displayName === undefined ? {} : { displayName };
    await this.db
      .insertInto("projectChoices")
      .values({ orgId, principalId, project, audienceId: group, ...named })
      .onConflict((conflict) =>
        conflict
          .columns(["orgId", "principalId", "project"])
          .doUpdateSet({ audienceId: group, ...named }),
      )
      .execute();
  }
}
