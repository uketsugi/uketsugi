import {
  isUuid,
  type Confirmation,
  type Flag,
  type FlagKind,
  type NewFlag,
  type NewRuling,
  type ReadScope,
  type ReviewRepo,
  type Ruling,
  type StoredEvent,
  type UnitReview,
} from "@uketsugi/core";
import type { Selectable } from "kysely";
import { actorColumns, actorOf, Repo, scoped, UnitRepo, uuidsOf } from "./codec.ts";
import type { Database } from "./schema.ts";

function toFlag(row: Selectable<Database["flags"]>): Flag {
  const { raisedByPerson, raisedByJob, ...flag } = row;
  return { ...flag, raisedBy: actorOf(raisedByPerson, raisedByJob) };
}

function toRuling(row: Selectable<Database["rulings"]>): Ruling {
  const { decidedByPerson, decidedByJob, ...ruling } = row;
  return { ...ruling, decidedBy: actorOf(decidedByPerson, decidedByJob) };
}

export function toEvent(row: Selectable<Database["events"]>): StoredEvent {
  const { actorPerson, actorJob, ...event } = row;
  return { ...event, actor: actorOf(actorPerson, actorJob) };
}

/** Confirmations, flags and rulings inside a unit. */
export class SqlUnitReview extends UnitRepo implements UnitReview {
  async confirm(confirmation: Omit<Confirmation, "orgId" | "audienceId">): Promise<void> {
    const { orgId, audienceId } = this.target;
    const { factId, person, at, sourceVersion, checked } = confirmation;
    const check = { at, sourceVersion, checked };
    await this.db
      .insertInto("confirmations")
      .values({ orgId, audienceId, factId, person, ...check })
      .onConflict((conflict) => conflict.columns(["orgId", "factId", "person"]).doUpdateSet(check))
      .execute();
  }

  async clearConfirmations(factId: string, exceptPerson: string): Promise<number> {
    const result = await this.db
      .deleteFrom("confirmations")
      .where(scoped(this.scope))
      .where("factId", "=", factId)
      .where("person", "<>", exceptPerson)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async raiseFlag(flag: NewFlag): Promise<boolean> {
    const { orgId, audienceId, at } = this.target;
    const { id, factId, kind } = flag;
    const by = actorColumns(flag.raisedBy);
    const raised = await this.db
      .insertInto("flags")
      .values({
        orgId,
        audienceId,
        id,
        factId,
        kind,
        raisedByPerson: by.person,
        raisedByJob: by.job,
        at,
      })
      // The same raiser's open flag of this kind on the fact: `flags_one_open`.
      .onConflict((conflict) => conflict.doNothing())
      .returning("id")
      .executeTakeFirst();
    return raised !== undefined;
  }

  async clearFlags(factId: string, kinds: readonly FlagKind[]): Promise<number> {
    if (kinds.length === 0) return 0;
    const result = await this.db
      .updateTable("flags")
      .set({ clearedAt: this.target.at })
      .where(scoped(this.scope))
      .where("factId", "=", factId)
      .where("kind", "in", [...kinds])
      .where("clearedAt", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async record(ruling: NewRuling): Promise<void> {
    const { orgId, audienceId, at } = this.target;
    const by = actorColumns(ruling.decidedBy);
    await this.db
      .insertInto("rulings")
      .values({
        orgId,
        audienceId,
        id: ruling.id,
        decision: ruling.decision,
        factId: ruling.factId,
        decidedByPerson: by.person,
        decidedByJob: by.job,
        reasons: JSON.stringify(ruling.reasons),
        at,
      })
      .execute();
  }

  async revert(rulingId: string, by: string): Promise<boolean> {
    const result = await this.db
      .updateTable("rulings")
      .set({ revertedBy: by })
      .where(scoped(this.scope))
      .where("id", "=", rulingId)
      .where("revertedBy", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}

/** Confirmations, flags, rulings and events outside a unit. */
export class SqlReview extends Repo implements ReviewRepo {
  private rulingsIn(scope: ReadScope) {
    return this.db.selectFrom("rulings").selectAll().where(scoped(scope));
  }

  private eventsIn(scope: ReadScope) {
    return this.db.selectFrom("events").selectAll().where(scoped(scope));
  }

  async confirmations(scope: ReadScope, factIds: readonly string[]): Promise<Confirmation[]> {
    const ids = uuidsOf(factIds);
    if (ids.length === 0) return [];
    return this.db
      .selectFrom("confirmations")
      .selectAll()
      .where(scoped(scope))
      .where("factId", "in", ids)
      .execute();
  }

  async openFlags(scope: ReadScope, factIds: readonly string[]): Promise<Flag[]> {
    const ids = uuidsOf(factIds);
    if (ids.length === 0) return [];
    const rows = await this.db
      .selectFrom("flags")
      .selectAll()
      .where(scoped(scope))
      .where("factId", "in", ids)
      .where("clearedAt", "is", null)
      .orderBy("at")
      .execute();
    return rows.map(toFlag);
  }

  async rulings(scope: ReadScope, limit: number): Promise<Ruling[]> {
    // Two rulings of one instant are told apart by their ids, which rise as they are made.
    const rows = await this.rulingsIn(scope)
      .orderBy("at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
    return rows.map(toRuling);
  }

  async ruling(scope: ReadScope, id: string): Promise<Ruling | null> {
    if (!isUuid(id)) return null;
    const row = await this.rulingsIn(scope).where("id", "=", id).executeTakeFirst();
    return row === undefined ? null : toRuling(row);
  }

  async rulingsOf(scope: ReadScope, factIds: readonly string[]): Promise<Ruling[]> {
    const ids = uuidsOf(factIds);
    if (ids.length === 0) return [];
    const rows = await this.rulingsIn(scope).where("factId", "in", ids).execute();
    return rows.map(toRuling);
  }

  async events(
    scope: ReadScope,
    audienceId: string,
    afterSeq: number,
    limit: number,
  ): Promise<StoredEvent[]> {
    const rows = await this.eventsIn(scope)
      .where("audienceId", "=", audienceId)
      .where("seq", ">", afterSeq)
      .orderBy("seq")
      .limit(limit)
      .execute();
    return rows.map(toEvent);
  }

  async history(scope: ReadScope, subject: string, limit: number): Promise<StoredEvent[]> {
    if (!isUuid(subject)) return [];
    // A record that moved has entries in two logs: time orders them, the sequence within one.
    const rows = await this.eventsIn(scope)
      .where("subject", "=", subject)
      .orderBy("at", "desc")
      .orderBy("seq", "desc")
      .limit(limit)
      .execute();
    return rows.map(toEvent);
  }

  async publishedIn(scope: ReadScope, sessionId: string): Promise<string[]> {
    if (!isUuid(sessionId)) return [];
    const rows = await this.eventsIn(scope)
      .where("session", "=", sessionId)
      .where("kind", "=", "FactPublished")
      .orderBy("at")
      .orderBy("seq")
      .execute();
    return rows.map((row) => row.subject);
  }
}
