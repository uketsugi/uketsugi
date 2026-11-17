/**
 * What a failed reading of a session leaves for a person to be shown: when it failed and the
 * provider's reason, which the model step has already cut short and cleaned of any key. The
 * next reading that finishes clears both.
 */
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const DIGEST_FAILURE_0003: Migration = {
  async up(db) {
    await sql`ALTER TABLE sessions
      ADD COLUMN digest_failed_at timestamptz,
      ADD COLUMN digest_failure text,
      ADD CONSTRAINT sessions_failure_has_both
        CHECK ((digest_failed_at IS NULL) = (digest_failure IS NULL))`.execute(db);
  },
};
