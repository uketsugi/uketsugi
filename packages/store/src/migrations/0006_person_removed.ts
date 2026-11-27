/** A person can be removed: their row stays, so what they shared still names them, and says when they went. */
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const PERSON_REMOVED_0006: Migration = {
  async up(db) {
    await sql`ALTER TABLE principals ADD COLUMN removed_at timestamptz`.execute(db);
  },
};
