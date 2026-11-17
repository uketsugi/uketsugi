/** A project carries no date: nothing ever read the one it was made with. */
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const UNREAD_0004: Migration = {
  async up(db) {
    await sql`ALTER TABLE projects DROP COLUMN created_at`.execute(db);
  },
};
