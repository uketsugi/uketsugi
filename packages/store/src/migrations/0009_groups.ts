/**
 * Groups: an audience is a person's own or a group's, and a group has members. The one shared
 * audience every organization with several people had becomes the group `everyone`, with every
 * person on it a member, and a project that was shared is shared with it, so a store this runs on
 * behaves as before. A person's choice for a project names the group it is shared with (none:
 * private). The organization's first person is its administrator. An invitation is how a person joins an organization on a server that has no mail.
 */
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

const STEPS = [
  // The person who made an organization is its administrator: its first principal that is still
  // there, for a person who was removed cannot be asked for anything.
  sql`ALTER TABLE principals ADD COLUMN administrator boolean NOT NULL DEFAULT false`,
  sql`UPDATE principals p SET administrator = true
    WHERE p.removed_at IS NULL AND p.id = (SELECT min(q.id::text)::uuid FROM principals q
      WHERE q.org_id = p.org_id AND q.removed_at IS NULL)`,
  sql`CREATE TABLE audience_members (
    org_id uuid NOT NULL,
    audience_id uuid NOT NULL,
    principal_id uuid NOT NULL,
    PRIMARY KEY (org_id, audience_id, principal_id),
    FOREIGN KEY (org_id, audience_id) REFERENCES audiences (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, principal_id) REFERENCES principals (org_id, id) ON DELETE CASCADE
  )`,
  sql`CREATE INDEX audience_members_by_person ON audience_members (org_id, principal_id)`,
  sql`ALTER TABLE audiences ADD COLUMN name text`, // a group's name; NULL for a person's own
  sql`UPDATE audiences SET name = 'everyone' WHERE kind = 'shared'`,
  sql`INSERT INTO audience_members (org_id, audience_id, principal_id)
    SELECT a.org_id, a.id, p.id FROM audiences a
    JOIN principals p ON p.org_id = a.org_id
    WHERE a.kind = 'shared' AND p.removed_at IS NULL`,
  sql`ALTER TABLE audiences DROP CONSTRAINT audiences_kind_check`,
  sql`UPDATE audiences SET kind = 'group' WHERE kind = 'shared'`,
  sql`ALTER TABLE audiences ADD CONSTRAINT audiences_kind_check CHECK (kind IN ('private', 'group'))`,
  sql`ALTER TABLE audiences ADD CONSTRAINT audiences_group_named CHECK ((kind = 'group') = (name IS NOT NULL))`,
  sql`DROP INDEX audiences_one_shared`,
  sql`CREATE UNIQUE INDEX audiences_group_by_name ON audiences (org_id, name) WHERE kind = 'group'`,
  sql`ALTER TABLE project_choices ADD COLUMN audience_id uuid`, // the group it is shared with; NULL: private
  sql`ALTER TABLE project_choices
    ADD FOREIGN KEY (org_id, audience_id) REFERENCES audiences (org_id, id)`,
  sql`UPDATE project_choices c SET audience_id = a.id FROM audiences a
    WHERE c.treatment = 'shared' AND a.org_id = c.org_id AND a.kind = 'group'`,
  sql`ALTER TABLE project_choices DROP COLUMN treatment`,
  sql`CREATE TABLE invitations (
    org_id uuid NOT NULL,
    id uuid NOT NULL,
    token_hash bytea NOT NULL,                -- SHA-256 of the secret in the link; the secret is never stored
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (org_id, created_by) REFERENCES principals (org_id, id)
  )`,
  sql`CREATE UNIQUE INDEX invitations_by_token_hash ON invitations (token_hash)`,
];

export const GROUPS_0009: Migration = {
  async up(db) {
    for (const step of STEPS) await step.execute(db);
  },
};
