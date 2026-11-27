/** A folder with no origin is a project of its own kind, `path`, keyed `file://<machine>/<path>`. */
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const PATH_PROJECTS_0007: Migration = {
  async up(db) {
    await sql`ALTER TABLE projects DROP CONSTRAINT projects_kind_check`.execute(db);
    await sql`ALTER TABLE projects ADD CONSTRAINT projects_kind_check
      CHECK (kind IN ('repository', 'named', 'path'))`.execute(db);
  },
};
