import type { ClaimedJob, JobsRepo } from "@uketsugi/core";
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

  async complete(job: Pick<ClaimedJob, "orgId" | "id">): Promise<void> {
    await this.db
      .deleteFrom("outbox")
      .where("orgId", "=", job.orgId)
      .where("id", "=", job.id)
      .execute();
  }

  async fail(job: Pick<ClaimedJob, "orgId" | "id">, retryAt: Date | null): Promise<void> {
    await this.db
      .updateTable("outbox")
      .set({ lockedUntil: null, ...(retryAt === null ? { dead: true } : { runAfter: retryAt }) })
      .where("orgId", "=", job.orgId)
      .where("id", "=", job.id)
      .execute();
  }

  async counts(): Promise<{ waiting: number; dead: number }> {
    return this.db
      .selectFrom("outbox")
      .select([
        sql<number>`count(*) filter (where not dead)`.as("waiting"),
        sql<number>`count(*) filter (where dead)`.as("dead"),
      ])
      .executeTakeFirstOrThrow();
  }

  /**
   * One statement: a job for each live fact with no vector and no embed job, dead ones counted, so
   * a fact whose embedding kept failing is not tried for ever. A job's id is its fact's id: the
   * store makes no ids of its own, and a fact has one such job at a time.
   */
  async embedMissing(now: Date): Promise<number> {
    const left = await sql`
      insert into outbox (org_id, id, audience_id, kind, subject, run_after)
      select f.org_id, f.id, f.audience_id, 'embed', f.id, ${now}
      from facts f
      where f.vector is null and ${live("f")}
        and not exists (
          select 1 from outbox o
          where o.org_id = f.org_id and o.subject = f.id and o.kind = 'embed')
      on conflict do nothing`.execute(this.db);
    return Number(left.numAffectedRows ?? 0n);
  }
}
