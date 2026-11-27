/**
 * The store records which embedding model made its vectors, as one row: a vector of another model
 * is never compared. Every store made before this holds vectors of the one model every release
 * pinned (every release so far, `granite-small-r2@int8:1f4cf47e4ade`), so a store that has any vector
 * is recorded as made by it; one with none is left unrecorded and takes the first model that
 * opens it, with nothing to discard.
 */
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const EMBEDDING_MODEL_0005: Migration = {
  async up(db) {
    await sql`CREATE TABLE embedding_model (
      id smallint PRIMARY KEY,
      model text NOT NULL,
      CONSTRAINT embedding_model_is_one_row CHECK (id = 1))`.execute(db);
    await sql`INSERT INTO embedding_model (id, model)
      SELECT 1, 'granite-small-r2@int8:1f4cf47e4ade'
      WHERE EXISTS (SELECT 1 FROM facts WHERE vector IS NOT NULL)`.execute(db);
  },
};
