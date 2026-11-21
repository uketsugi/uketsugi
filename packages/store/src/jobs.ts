import { isUuid, type ClaimedJob, type JobCounts, type JobsRepo } from "@uketsugi/core";
import { sql } from "kysely";
import { live, Repo } from "./codec.ts";

/** The outbox as a worker sees it. A claim takes rows no other claim holds, across organizations. */
export class SqlJobs extends Repo implements JobsRepo {
  async claim(now: Date, leaseMs: number, limit: number): Promise<ClaimedJob[]> {
    const until = new Date(now.getTime() + leaseMs);
    const claimed = await sql<ClaimedJob>`
      update outbox set locked_until = ${until}, attempts = attempts + 1
      where (org_id, id) in (
        select org_id, id from outbox
        where not dead and run_after <= ${now} and (locked_until is null or locked_until < ${now})
        order by run_after, id limit ${limit} for update skip locked
      )
      returning org_id, audience_id, id, kind, subject, run_after, attempts`.execute(this.db);
    return claimed.rows.sort(
      (a, b) => a.runAfter.getTime() - b.runAfter.getTime() || a.id.localeCompare(b.id),
    );
  }

  async complete(job: Pick<ClaimedJob, "orgId" | "id" | "runAfter">): Promise<void> {
    const retired = await this.db
      .deleteFrom("outbox")
      .where("orgId", "=", job.orgId)
      .where("id", "=", job.id)
      .where("runAfter", "=", job.runAfter)
      .executeTakeFirst();
    if (retired.numDeletedRows > 0n) return;
    // Armed again while it ran: it keeps its new time and is free to be claimed then.
    await this.release(job, {});
  }

  async fail(job: Pick<ClaimedJob, "orgId" | "id">, retryAt: Date | null): Promise<void> {
    await this.release(job, retryAt === null ? { dead: true } : { runAfter: retryAt });
  }

  /** Frees a claimed job's lock, and changes what else `change` says. */
  private async release(
    job: Pick<ClaimedJob, "orgId" | "id">,
    change: { dead?: true; runAfter?: Date },
  ): Promise<void> {
    await this.db
      .updateTable("outbox")
      .set({ lockedUntil: null, ...change })
      .where("orgId", "=", job.orgId)
      .where("id", "=", job.id)
      .execute();
  }

  async counts(): Promise<JobCounts> {
    const jobs = await this.db
      .selectFrom("outbox")
      .select([
        sql<number>`count(*) filter (where not dead)`.as("waiting"),
        sql<number>`count(*) filter (where dead)`.as("dead"),
        sql<number>`count(*) filter (where dead and run_after > now() - interval '24 hours')`.as(
          "deadRecent",
        ),
        sql<number>`count(*) filter (where dead and kind = 'embed')`.as("deadEmbeds"),
      ])
      .executeTakeFirstOrThrow();
    // A failure kept on a session counts only with its reading: one that is due, or one given up in the last day.
    const readings = await this.db
      .selectFrom("sessions as s")
      .innerJoin("outbox as o", (join) =>
        join
          .onRef("o.orgId", "=", "s.orgId")
          .onRef("o.id", "=", "s.id")
          .on("o.kind", "=", "digest"),
      )
      .select([
        sql<number>`count(*) filter (where not o.dead)`.as("readingsWaiting"),
        sql<number>`count(*) filter (where o.dead)`.as("readingsGivenUp"),
        sql<string | null>`(array_agg(s.digest_failure order by o.run_after desc))[1]`.as(
          "lastReadingFailure",
        ),
      ])
      .where("s.digestFailure", "is not", null)
      .where(sql<boolean>`(not o.dead or o.run_after > now() - interval '24 hours')`)
      .executeTakeFirstOrThrow();
    return { ...jobs, ...readings };
  }

  async embeddingModel(): Promise<string | null> {
    const row = await this.db.selectFrom("embeddingModel").select("model").executeTakeFirst();
    return row?.model ?? null;
  }

  /**
   * Makes the store's vectors the embedder's: when the model that made them is not `model`, every
   * vector is set to null and `model` recorded, in one statement. Then brings back the dead
   * `embed` jobs of live facts that have no vector, so that a fact whose embedding failed once
   * (the model did not load, say) is tried again by the next start, and leaves a job for every
   * such fact that has none: all of them, after a change of model. A job made by a write has an
   * id of its own, so a dead one is found by its subject; the one this leaves takes its fact's id.
   * Returns how many jobs it brought back or left.
   */
  async embedMissing(model: string, now: Date): Promise<number> {
    await sql`
      with cleared as (
        update facts set vector = null
        where vector is not null
          and (select model from embedding_model) is distinct from ${model})
      insert into embedding_model (id, model) values (1, ${model})
      on conflict (id) do update set model = excluded.model`.execute(this.db);
    const missing = sql`select f.org_id, f.id from facts f where f.vector is null and ${live("f")}`;
    const revived = await sql`
      update outbox set dead = false, attempts = 0, run_after = ${now}, locked_until = null
      where kind = 'embed' and dead and (org_id, subject) in (${missing})`.execute(this.db);
    const left = await sql`
      insert into outbox (org_id, id, audience_id, kind, subject, run_after)
      select f.org_id, f.id, f.audience_id, 'embed', f.id, ${now}
      from facts f
      where f.vector is null and ${live("f")}
        and not exists (
          select 1 from outbox o
          where o.org_id = f.org_id and o.subject = f.id and o.kind = 'embed')
      on conflict do nothing`.execute(this.db);
    return Number(revived.numAffectedRows ?? 0n) + Number(left.numAffectedRows ?? 0n);
  }

  async armDigest(orgId: string, sessionId: string, dueAt: Date): Promise<void> {
    // A session has one such job at a time, by its own id; a claim that holds it keeps its lock.
    await this.db
      .insertInto("outbox")
      .values({
        orgId,
        id: sessionId,
        audienceId: null,
        kind: "digest",
        subject: sessionId,
        runAfter: dueAt,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["orgId", "id"])
          .doUpdateSet({ runAfter: dueAt, attempts: 0, dead: false }),
      )
      .execute();
  }

  async hastenDigest(orgId: string, sessionId: string, now: Date): Promise<void> {
    if (!isUuid(sessionId)) return;
    await this.db
      .updateTable("outbox")
      .set({ runAfter: now })
      .where("orgId", "=", orgId)
      .where("id", "=", sessionId)
      .where("kind", "=", "digest")
      .where("runAfter", ">", now)
      .where("dead", "=", false)
      .execute();
  }
}
