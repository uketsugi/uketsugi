/** An organization's administrator: the one person whose `administrator` flag is set. */
import { sql } from "kysely";
import type { Db } from "./codec.ts";

/**
 * The flag moves from `from` to `to` in one transaction, so there is one administrator at every
 * moment. False, with nothing changed, when `from` is not the administrator or `to` is not a
 * person who is there.
 */
export function handOverIn(db: Db, orgId: string, from: string, to: string): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom("principals")
      .select(["id", "administrator"])
      .where("orgId", "=", orgId)
      .where("id", "in", [from, to])
      .where("removedAt", "is", null)
      .forUpdate()
      .execute();
    const flag = (id: string) => rows.find((row) => row.id === id)?.administrator;
    if (from === to || flag(from) !== true || flag(to) !== false) return false;
    await trx
      .updateTable("principals")
      .set({ administrator: sql<boolean>`id = ${to}` })
      .where("orgId", "=", orgId)
      .where("id", "in", [from, to])
      .execute();
    return true;
  });
}
