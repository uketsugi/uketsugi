/**
 * The search statements: the keyword, identifier and vector passes in one scan of the pool, the
 * trigram pass over their candidates, and what fusion and standing read of the kept facts. Every
 * statement filters on the organization, the visible audiences and the project, and skips
 * superseded facts and stubs.
 *
 * `facts.tsv` weights the claim A, the detail B and the question C. The keyword pass admits a fact
 * on its A and B lexemes only, and ranks it over all three, so by its wording a question adds to
 * the score of a fact its own text admitted and never admits one.
 */
import {
  normalizeText,
  type CandidateRow,
  type PassRow,
  type SearchQuery,
  type SearchRepo,
} from "@uketsugi/core";
import { sql, type RawBuilder } from "kysely";
import { live, Repo, scoped, uuidsOf, vectorUnder } from "./codec.ts";

/** The query's lexemes, as the same analyzer that built `facts.tsv` reads them. */
function lexemesOf(query: SearchQuery): RawBuilder<string[]> {
  return sql<string[]>`tsvector_to_array(to_tsvector('english', ${query.query}))`;
}

/** The share of the query's lexemes a fact's own text (claim and detail) holds. */
function coverage(lexemes: RawBuilder<unknown>): RawBuilder<number> {
  return sql<number>`(coalesce((select count(*) from unnest(${lexemes}) l
      where l = any(tsvector_to_array(ts_filter(f.tsv, '{a,b}')))), 0)::float8
    / greatest(cardinality(${lexemes}), 1))`;
}

/** The facts `f` a search may score: the reader's scope, the project, live facts only. */
function pool(query: SearchQuery): RawBuilder<boolean> {
  return sql<boolean>`${scoped(query.scope, "f")} and f.project = ${query.project} and ${live("f")}`;
}

export class SqlSearch extends Repo implements SearchRepo {
  /**
   * One scan of the pool for three passes. Each fact yields one (pass, score) pair per pass it
   * matches, so a single window ranks every pass: the keyword pass by `ts_rank_cd`, the vector
   * pass by cosine, the identifier pass by how many of the query's identifiers the fact holds.
   * Those are counted once, from the identifier index (`held`), and joined to the scan. The index
   * holds the identifiers of a fact's own text only: core does not take one from its question.
   */
  async passes(query: SearchQuery): Promise<PassRow[]> {
    const found = await sql<PassRow>`
      with l as (select ${lexemesOf(query)} as lexemes),
      q as (
        select l.lexemes as q_lexemes,
               (select string_agg(quote_literal(x), ' | ') from unnest(l.lexemes) x)::tsquery as q_any,
               (select string_agg(quote_literal(x) || ':AB', ' | ') from unnest(l.lexemes) x)::tsquery as q_own,
               ${vectorUnder(query.embedding)} as q_emb
        from l
      ),
      held as (
        select i.fact_id, count(*)::float8 as idents
        from fact_idents i
        join facts f on f.org_id = i.org_id and f.id = i.fact_id
        where i.org_id = ${query.scope.orgId} and i.ident = any(${[...query.idents]}::text[])
          and ${pool(query)}
        group by i.fact_id
      )
      select fact_id, pass, rank
      from (
        select f.id as fact_id, v.pass,
               row_number() over (partition by v.pass order by v.score desc, f.updated_at desc, f.id desc) as rank
        from facts f
        cross join q
        left join held on held.fact_id = f.id
        cross join lateral (select 1 - (f.vector <=> q.q_emb) as cosine) c
        cross join lateral (values
          ('keyword', case when f.tsv @@ q.q_own
                                and (c.cosine is null or ${coverage(sql`q.q_lexemes`)} >= ${query.admissionCoverage})
                           then ts_rank_cd(f.tsv, q.q_any, 32)::float8 end),
          ('identifier', held.idents),
          ('vector', case when c.cosine >= ${query.vectorCutoff} then c.cosine::float8 end)
        ) v(pass, score)
        where ${pool(query)} and v.score is not null
      ) scored
      where rank <= ${query.passLimit}
      order by pass, rank`.execute(this.db);
    return found.rows;
  }

  async trigram(query: SearchQuery, candidateIds: readonly string[]): Promise<PassRow[]> {
    const ids = uuidsOf(candidateIds);
    if (ids.length === 0) return [];
    const text = normalizeText(query.query);
    const found = await sql<PassRow>`
      select fact_id, 'trigram' as pass, rank
      from (
        select f.id as fact_id,
               row_number() over (order by word_similarity(${text}, f.search_text) desc, f.updated_at desc, f.id desc) as rank
        from facts f
        where ${pool(query)} and f.id = any(${ids}::uuid[])
          and word_similarity(${text}, f.search_text) >= ${query.trigramThreshold}
      ) scored
      where rank <= ${query.passLimit}
      order by rank`.execute(this.db);
    return found.rows;
  }

  async candidates(query: SearchQuery, factIds: readonly string[]): Promise<CandidateRow[]> {
    const ids = uuidsOf(factIds);
    if (ids.length === 0) return [];
    const found = await sql<CandidateRow>`
      with t as (select ${lexemesOf(query)} as lexemes, ${vectorUnder(query.embedding)} as embedding)
      select f.id as fact_id, (1 - (f.vector <=> t.embedding))::float8 as cosine,
             ${coverage(sql`t.lexemes`)} as lexeme_coverage, f.status, f.author, f.updated_at,
             exists (select 1 from flags g
                      where ${scoped(query.scope, "g")} and g.fact_id = f.id
                        and g.cleared_at is null) as flagged,
             (select max(c.at) from confirmations c
               where ${scoped(query.scope, "c")} and c.fact_id = f.id) as confirmed_at
      from facts f cross join t
      where ${pool(query)} and f.id = any(${ids}::uuid[])`.execute(this.db);
    return found.rows;
  }
}
