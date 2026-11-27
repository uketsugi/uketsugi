/** A person's other names for a project: what a join of one project into another leaves behind. */
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const PROJECT_NAMES_0008: Migration = {
  async up(db) {
    await sql`CREATE TABLE project_names (
      org_id uuid NOT NULL,
      principal_id uuid NOT NULL,
      name text NOT NULL,                     -- a key the person's calls still carry
      project text NOT NULL,                  -- the project it now means for them
      PRIMARY KEY (org_id, principal_id, name),
      FOREIGN KEY (org_id, principal_id) REFERENCES principals (org_id, id) ON DELETE CASCADE,
      FOREIGN KEY (org_id, project) REFERENCES projects (org_id, key)
    )`.execute(db);
  },
};
