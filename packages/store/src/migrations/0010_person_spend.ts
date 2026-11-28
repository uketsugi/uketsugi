/**
 * What the model step costs each person, for a server that sets a limit on a person and on an
 * organization: every spend names the person whose session was read, and a session says in words
 * why its reading waits when a limit held it back.
 *
 * A spend recorded before this names nobody: it still counts in what its organization and its
 * server spent, and in no person's share, since the table never said whose it was. A person's
 * share is counted over a day, so those rows are gone from it within a week, as they always were.
 */
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const PERSON_SPEND_0010: Migration = {
  async up(db) {
    await sql`ALTER TABLE model_spend ADD COLUMN principal_id uuid`.execute(db);
    // A limit asks for what an organization or one of its people spent since a time.
    await sql`CREATE INDEX model_spend_by_org ON model_spend (org_id, at)`.execute(db);
    await sql`ALTER TABLE sessions ADD COLUMN digest_waiting text`.execute(db);
  },
};
