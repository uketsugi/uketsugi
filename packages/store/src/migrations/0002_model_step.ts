/**
 * What the model step needs, added to a store that 0.1.0 made: which session a model wrote a fact
 * from, the turns a session's hook leaves for the model to read, what a model's reading of a
 * session came to, what every model call cost and when, a job that is about a session, and the
 * way to what was published in one session.
 *
 * A turn is one person's, like the session it hangs off: a directory record, never joined with
 * facts, and gone with its session. A fact names its session by id alone: a data table holds no
 * key into the directory.
 */
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

const STATEMENTS = [
  // NULL for a fact an agent published. Its author is still a person: the session's.
  sql`ALTER TABLE facts ADD COLUMN digest_session uuid`,

  // What a model's reading of the session came to: when it last finished one, what every model
  // call about the session cost, and the facts it chose for the person's next brief in the project.
  sql`ALTER TABLE sessions
    ADD COLUMN digested_at timestamptz,
    ADD COLUMN model_input_tokens integer NOT NULL DEFAULT 0,
    ADD COLUMN model_output_tokens integer NOT NULL DEFAULT 0,
    ADD COLUMN brief_picks jsonb`,

  // What the person asked and the agent's final answer, scanned. A row lives until the model step
  // has read it, or has given up reading it.
  sql`CREATE TABLE session_turns (
    org_id uuid NOT NULL,
    session_id uuid NOT NULL,
    id uuid NOT NULL,
    request text,
    answer text,
    at timestamptz NOT NULL,
    PRIMARY KEY (org_id, session_id, id),
    FOREIGN KEY (org_id, session_id) REFERENCES sessions (org_id, id) ON DELETE CASCADE,
    CONSTRAINT session_turns_say_something CHECK (num_nonnulls(request, answer) > 0)
  )`,

  // What every model call cost and when, for the budget a server's operator sets over a stretch
  // of time. A row older than a week is of no use to it and is deleted as new ones are written.
  sql`CREATE TABLE model_spend (
    org_id uuid NOT NULL,
    at timestamptz NOT NULL,
    tokens integer NOT NULL
  )`,
  sql`CREATE INDEX model_spend_by_time ON model_spend (at)`,

  // A `digest` job is about a session, which has no audience: it names none, and a key with a
  // null in it ties the row to no fact. Every other job still names its fact's audience, is held
  // to its fact by that key, and moves with it.
  sql`ALTER TABLE outbox ALTER COLUMN audience_id DROP NOT NULL`,
  sql`ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check`,
  sql`ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check
    CHECK (kind IN ('embed', 'consolidate', 'digest'))`,
  sql`ALTER TABLE outbox ADD CONSTRAINT outbox_audience_unless_about_a_session
    CHECK ((kind = 'digest') = (audience_id IS NULL))`,

  // What was published in one session: read for the session's digest and for the next brief.
  sql`CREATE INDEX events_by_session ON events (org_id, session) WHERE session IS NOT NULL`,
];

export const MODEL_STEP_0002: Migration = {
  async up(db) {
    for (const statement of STATEMENTS) await statement.execute(db);
  },
};
